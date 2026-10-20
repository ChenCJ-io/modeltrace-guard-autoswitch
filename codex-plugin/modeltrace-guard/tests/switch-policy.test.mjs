import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { abandon, newState, readState, withState } from '../scripts/state.mjs';
import { controlContext, handleHook, isControlCommand, ROOT, run } from '../scripts/guard.mjs';
import { atomicJSON, approveSwitch, beginVerification, configureGateway, declineSwitch, eligibleForSwitch,
  enableAutoSwitch, finishVerification, haltBlocksProbe, loadGatewayConfig, prepareSwitchTransport, proposeSwitch,
  queueAutoSwitch, resolveSessionRoute, saveReceipt } from '../scripts/switch-policy.mjs';

const execute = promisify(execFile);
const readiness = { accountType: 'chatgpt', modelProvider: 'openai', model: 'expected' };
const sourceId = 'test-source', fallbackId = 'test-official', alternateId = 'test-alternate';
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoswitch-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await atomicJSON(path.join(directory, 'live-state.json'), { apps: { codex: { mode: 'proxy', attached: true, proxy_route: sourceId,
    stack: { enabled: true, members: [sourceId, alternateId], keys: { company: sourceId, alternate: alternateId } } } } });
  await execute('sqlite3', [path.join(directory, 'cc-switch.db'), `CREATE TABLE providers(id TEXT,name TEXT,category TEXT,app_type TEXT,settings_config TEXT,meta TEXT);
    INSERT INTO providers VALUES
    ('${sourceId}','Company',NULL,'codex','{"auth":{"OPENAI_API_KEY":"synthetic-only"},"config":""}','{}'),
    ('${alternateId}','Alternate',NULL,'codex','{"auth":{"OPENAI_API_KEY":"synthetic-only"},"config":""}','{}'),
    ('${fallbackId}','Official','official','codex','{"auth":{},"config":""}','{}');
    CREATE TABLE proxy_config(app_type TEXT,listen_address TEXT,listen_port INTEGER);
    INSERT INTO proxy_config VALUES('codex','127.0.0.1',15721);`]);
  await configureGateway(directory, { primaryName: 'Company', backupName: 'Official', ccSwitchDirectory: directory });
  return { directory, config: await loadGatewayConfig(directory), session: randomUUID() };
}
function receipt(thread, route, extra = {}) {
  return { threadId: thread, ...route, requestId: randomUUID(), completed: true, success: true, responseEvent: 'response.completed',
    statusCode: 200, startedAt: Date.now() - 10, finishedAt: Date.now(), proposalId: null, approvalId: null, challenge: null, ...extra };
}
async function enable(f) {
  const route = await resolveSessionRoute(f.directory, f.config, f.session);
  await saveReceipt(f.directory, f.config, receipt(f.session, route));
  return enableAutoSwitch(f.directory, f.session, readiness);
}
const descriptor = (id, transport, key = null) => ({ id, name: id, transport, key, fingerprint: (id === 'primary' ? 'a' : 'b').repeat(64) });
function evidenceState(config) {
  const state = newState(randomUUID());
  state.enabled = true; state.model = state.expected = 'expected'; state.epoch = 1;
  const primary = config?.primary || descriptor('primary', 'ccswitch', 'company');
  const backup = config?.backup || descriptor('personal', 'official');
  state.autoSwitch = { protocol: 3, approvalMode: 'per_incident', enabled: true, phase: 'armed', route: 'source', revision: 1,
    attempts: 0, configId: config?.id || randomUUID(), policyId: randomUUID(), primary, backup, current: primary };
  state.samples.push({ challenge: randomUUID(), at: Date.now(), epoch: 1, language: 'en', reportedModel: 'expected', expected: 'expected',
    expectedWeight: 0.01, prediction: 'other', outcome: 'difference_signal', fork: { routing: {
      route: 'source', providerId: primary.id, providerFingerprint: primary.fingerprint, transport: primary.transport, sourceKey: primary.key,
      success: true, completed: true, configId: state.autoSwitch.configId, policyId: state.autoSwitch.policyId, revision: 1,
    } } });
  return state;
}
function approvedState() {
  const state = evidenceState();
  queueAutoSwitch(state, Date.now());
  const r = state.switchRequest;
  r.status = 'approved';
  r.approval = { id: randomUUID(), requestId: r.id, haltId: r.haltId, providerId: r.target.id, fingerprint: r.target.fingerprint,
    configId: r.configId, policyId: r.policyId, revision: r.revision };
  assert.equal(beginVerification(state, Date.now()), true);
  return state;
}
function canary(state) {
  const r = state.switchRequest, target = r.target;
  return { expected: 'expected', prediction: 'expected', outcome: 'compatible', fork: { routing: {
    route: 'fallback', success: true, completed: true, configId: r.configId, policyId: r.policyId, revision: r.revision + 1,
    providerId: target.id, providerFingerprint: target.fingerprint, transport: target.transport, sourceKey: target.key,
    proposalId: r.id, approvalId: r.approval.id, challenge: state.pending.id,
    threadId: randomUUID(), requestId: randomUUID(), finishedAt: Date.now(),
  } } };
}
async function pendingIncident(f) {
  await enable(f);
  await withState(f.directory, f.session, state => {
    const evidence = evidenceState(f.config).samples[0];
    evidence.fork.routing.policyId = state.autoSwitch.policyId;
    state.samples.push(evidence);
    assert.equal(queueAutoSwitch(state, Date.now(), evidence), true);
  });
  return (await readState(f.directory, f.session)).switchRequest;
}

test('first request uses primary, enable never changes it, and another thread has no monitor', async t => {
  const f = await fixture(t), sibling = randomUUID();
  assert.equal((await resolveSessionRoute(f.directory, f.config, f.session)).providerId, sourceId);
  assert.equal((await readState(f.directory, f.session)).enabled, false);
  await assert.rejects(enableAutoSwitch(f.directory, f.session, readiness), /successful primary/);
  await enable(f);
  assert.equal((await resolveSessionRoute(f.directory, f.config, f.session)).providerId, sourceId);
  assert.equal((await resolveSessionRoute(f.directory, f.config, sibling)).providerId, sourceId);
  assert.equal((await readState(f.directory, sibling)).enabled, false);
  await assert.rejects(enable(f), /already has a route policy/);
  await withState(f.directory, f.session, state => { state.autoSwitch.enabled = false; });
  assert.equal((await resolveSessionRoute(f.directory, f.config, f.session)).providerId, sourceId);
});

test('only a valid current-route mismatch can request consent, including a clearly labelled weak disagreement', () => {
  assert.equal(eligibleForSwitch(evidenceState()), true);
  const weak = evidenceState(); weak.samples[0].outcome = 'inconclusive'; assert.equal(eligibleForSwitch(weak), true);
  for (const mutate of [s => { s.samples[0].fork.routing.success = false; }, s => { s.samples[0].fork.routing.completed = false; },
    s => { s.samples[0].fork.routing.providerId = 'other'; }, s => { s.samples[0].fork.routing.providerFingerprint = 'old'; },
    s => { s.samples[0].fork.routing.revision = 0; }, s => { s.samples[0].fork.routing.configId = 'old'; },
    s => { s.autoSwitch.enabled = false; }, s => { s.samples[0].outcome = 'unknown_expected_model'; },
    s => { s.samples[0].expectedWeight = null; }, s => { s.samples[0].epoch = 0; }]) {
    const state = evidenceState(); mutate(state); assert.equal(eligibleForSwitch(state), false);
  }
});

test('first anomaly halts without probing backup; ack and Stop yield without granting consent', async t => {
  const f = await fixture(t), incident = await pendingIncident(f);
  await withState(f.directory, f.session, state => { state.alerts.push({ id: incident.haltId, at: Date.now(), acknowledgedAt: null }); });
  const ack = await run(['acknowledge', '--session', f.session, '--data-dir', f.directory, '--alert', incident.haltId], {});
  assert.equal(ack.agentAction, 'ask_user_to_switch');
  const state = await readState(f.directory, f.session);
  assert.equal(beginVerification(state, Date.now()), false);
  assert.equal(state.pending, null); assert.equal(state.switchRequest.approval, null);
  assert.equal(haltBlocksProbe(state), true); assert.match(controlContext(state, f.directory), /ASK THE USER/);
  const stop = await handleHook({ session_id: f.session, hook_event_name: 'Stop' }, f.directory);
  assert.equal(stop.decision, undefined);
  const edit = await handleHook({ session_id: f.session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'touch should-not-run' } }, f.directory);
  assert.equal(edit.hookSpecificOutput.permissionDecision, 'deny');
});

test('the only approval path requires exact incident and target, reported alert, and native readiness', async t => {
  const f = await fixture(t), r = await pendingIncident(f);
  await withState(f.directory, f.session, state => { state.alerts.push({ id: r.haltId, acknowledgedAt: null }); });
  await assert.rejects(approveSwitch(f.directory, f.session, r.id, r.target.id, readiness), /reported alerts/);
  await run(['acknowledge', '--session', f.session, '--data-dir', f.directory, '--alert', r.haltId], {});
  for (const [id, target, settings] of [[randomUUID(), r.target.id, readiness], [r.id, sourceId, readiness],
    [r.id, r.target.id, { ...readiness, accountType: 'apikey' }], [r.id, r.target.id, { ...readiness, model: 'different' }]]) {
    await assert.rejects(approveSwitch(f.directory, f.session, id, target, settings));
  }
  await approveSwitch(f.directory, f.session, r.id, r.target.id, readiness);
  const state = await readState(f.directory, f.session);
  assert.equal(state.pending.kind, 'fallback_verification');
  assert.equal(state.autoSwitch.current.id, sourceId); assert.ok(state.taskHalt);
  await assert.rejects(approveSwitch(f.directory, f.session, r.id, r.target.id, readiness));
});

test('retarget by name creates a new incident ID and rejects the old target/consent', async t => {
  const f = await fixture(t), old = await pendingIncident(f);
  const updated = await proposeSwitch(f.directory, f.session, old.id, { name: 'Alternate' });
  assert.notEqual(updated.id, old.id); assert.equal(updated.target.id, alternateId); assert.equal(updated.approval, null);
  await assert.rejects(approveSwitch(f.directory, f.session, old.id, fallbackId, readiness));
  await assert.rejects(approveSwitch(f.directory, f.session, updated.id, fallbackId, readiness));
  await approveSwitch(f.directory, f.session, updated.id, alternateId, readiness);
  const state = await readState(f.directory, f.session), sample = canary(state), checkpoint = state.pending;
  finishVerification(state, sample, checkpoint, Date.now());
  assert.equal(state.autoSwitch.current.id, alternateId); assert.equal(state.enabled, true);
  assert.equal(state.autoSwitch.enabled, true, 'third-party backup remains monitored');
  assert.equal(state.switchRequest.status, 'succeeded');
  state.samples.push({ ...state.samples[0], epoch: state.epoch, challenge: randomUUID(), fork: { routing: {
    ...sample.fork.routing, revision: state.autoSwitch.revision,
  } } });
  assert.equal(queueAutoSwitch(state, Date.now()), true, 'next anomaly requires fresh consent');
  assert.equal(state.switchRequest.approval, null);
});

test('a saved target mutation invalidates consent even when the display ID is unchanged', async t => {
  const f = await fixture(t), old = await pendingIncident(f);
  const r = await proposeSwitch(f.directory, f.session, old.id, { name: 'Alternate' });
  await execute('sqlite3', [path.join(f.directory, 'cc-switch.db'), `UPDATE providers SET name='Edited Alternate' WHERE id='${alternateId}'`]);
  await assert.rejects(approveSwitch(f.directory, f.session, r.id, r.target.id, readiness), /changed/);
  const fresh = await proposeSwitch(f.directory, f.session, r.id, { name: 'Edited Alternate' });
  assert.notEqual(fresh.id, r.id); assert.notEqual(fresh.target.fingerprint, r.target.fingerprint);
});

test('explicit refusal continues the same source without any backup probe or immediate new check', async t => {
  const f = await fixture(t), r = await pendingIncident(f);
  await declineSwitch(f.directory, f.session, r.id);
  const state = await readState(f.directory, f.session);
  assert.equal(state.taskHalt, null); assert.equal(state.autoSwitch.current.id, sourceId);
  assert.equal(state.switchRequest.status, 'declined'); assert.equal(state.pending, null);
  assert.equal(state.forceProbe, false); assert.ok(state.nextTools > state.workTools);
  await assert.rejects(approveSwitch(f.directory, f.session, r.id, r.target.id, readiness));
});

test('one approved Official success preserves thread/history and stops later monitoring', () => {
  const state = approvedState(), original = structuredClone(state.samples), session = state.session;
  const checkpoint = state.pending;
  finishVerification(state, canary(state), checkpoint, Date.now());
  assert.equal(state.taskHalt, null); assert.equal(state.autoSwitch.current.transport, 'official');
  assert.equal(state.autoSwitch.revision, 2); assert.equal(state.switchRequest.status, 'succeeded');
  assert.equal(state.enabled, false); assert.equal(state.autoSwitch.enabled, false);
  assert.equal(state.pending, null); assert.equal(state.forceProbe, false); assert.equal(state.nextTools, null);
  assert.equal(state.missed, 0); assert.equal(state.session, session); assert.deepEqual(state.samples, original);
  assert.equal(queueAutoSwitch(state, Date.now()), false);
});

test('failed, stale, wrong-target or revoked receipts cannot clear the halt', () => {
  for (const mutate of [(s, a) => { a.fork.routing.success = false; }, (s, a) => { a.prediction = 'other'; },
    (s, a) => { a.outcome = 'inconclusive'; }, (s, a) => { a.fork.routing.revision = 1; },
    (s, a) => { a.fork.routing.approvalId = 'old'; }, (s, a) => { a.fork.routing.proposalId = 'old'; },
    (s, a) => { a.fork.routing.challenge = 'old'; }, (s, a) => { a.fork.routing.providerFingerprint = 'changed'; },
    s => { s.runtimePaused = true; }, s => { s.autoSwitch.enabled = false; }, s => { s.taskHalt.id = 'another-halt'; },
    s => { s.epoch++; }]) {
    const state = approvedState(), checkpoint = state.pending, sample = canary(state); mutate(state, sample);
    finishVerification(state, sample, checkpoint, Date.now());
    assert.ok(state.taskHalt); assert.equal(state.autoSwitch.phase, 'failed'); assert.equal(state.autoSwitch.route, 'source');
  }
  const state = approvedState(); abandon(state, Date.now(), 'expired');
  assert.equal(state.switchRequest.status, 'failed'); assert.equal(haltBlocksProbe(state), true);
});

test('failed canary can be reproposed with fresh consent, never inherited from the failed request', async t => {
  const f = await fixture(t), r = await pendingIncident(f);
  await approveSwitch(f.directory, f.session, r.id, r.target.id, readiness);
  await withState(f.directory, f.session, state => abandon(state, Date.now(), 'test_target_unavailable'));
  const fresh = await proposeSwitch(f.directory, f.session, r.id, { name: 'Alternate' });
  assert.notEqual(fresh.id, r.id); assert.equal(fresh.approval, null);
  await assert.rejects(approveSwitch(f.directory, f.session, r.id, fallbackId, readiness));
  await approveSwitch(f.directory, f.session, fresh.id, alternateId, readiness);
});

test('fork binding pins exact route and successful receipt survives late failed retry metadata', async t => {
  const f = await fixture(t); await enable(f);
  const fork = randomUUID(), pending = { id: randomUUID(), epoch: 1, at: Date.now(), expiresAt: Date.now() + 60000 };
  await withState(f.directory, f.session, s => { s.pending = pending; });
  const transport = await prepareSwitchTransport(f.directory, { id: randomUUID(), sourceSession: f.session, provider: 'openai' }, pending);
  await assert.rejects(transport.authorize(f.session), /disposable/);
  await transport.authorize(fork);
  const route = await resolveSessionRoute(f.directory, f.config, fork);
  assert.equal(route.providerId, sourceId);
  const failed = receipt(fork, route, { challenge: pending.id, startedAt: pending.at, success: false });
  await saveReceipt(f.directory, f.config, failed);
  const result = transport.receipt();
  await delay(30);
  await saveReceipt(f.directory, f.config, { ...failed, requestId: randomUUID(), success: true });
  await saveReceipt(f.directory, f.config, failed);
  assert.equal((await result).success, true);
  await withState(f.directory, f.session, s => { s.pending.id = randomUUID(); });
  await assert.rejects(resolveSessionRoute(f.directory, f.config, fork), /live checkpoint/);
  await transport.close();
});

test('interruption revokes incident approval and control exemption cannot execute arbitrary shell', async t => {
  const f = await fixture(t), r = await pendingIncident(f);
  await approveSwitch(f.directory, f.session, r.id, r.target.id, readiness);
  await handleHook({ session_id: f.session, hook_event_name: 'Interrupt', turn_id: 'turn-a' }, f.directory);
  const stopped = await readState(f.directory, f.session);
  assert.equal(stopped.switchRequest.status, 'failed'); assert.ok(stopped.taskHalt);
  assert.equal(stopped.pending, null); assert.equal(beginVerification(stopped, Date.now()), false);
  const command = `node '${ROOT}/scripts/guard.mjs' approve-switch --request '${r.id}' --target-provider '${r.target.id}'`;
  assert.equal(isControlCommand({ tool_name: 'Bash', tool_input: { command } }), true);
  assert.equal(isControlCommand({ tool_name: 'Bash', tool_input: { command: command + '; touch bypass' } }), false);
});
