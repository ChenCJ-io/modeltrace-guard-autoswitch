import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { abandon, newState, readState, sessionPath, withState } from '../scripts/state.mjs';
import { controlContext, handleHook, isControlCommand, ROOT, run } from '../scripts/guard.mjs';
import { handleBackgroundHook } from '../scripts/background.mjs';
import { listSwitchCandidates } from '../scripts/switch-candidates.mjs';
import { runAutoSwitch } from '../scripts/autoswitch.mjs';
import { atomicJSON, approveSwitch, beginVerification, configureGateway, declineSwitch, eligibleForSwitch,
  enableAutoSwitch, finishVerification, haltBlocksProbe, loadGatewayConfig, prepareSwitchTransport, proposeSwitch,
  queueAutoSwitch, requestManualSwitch, resolveSessionRoute, resumeMonitoring, saveReceipt } from '../scripts/switch-policy.mjs';

const execute = promisify(execFile);
const readiness = { accountType: 'chatgpt', modelProvider: 'openai', model: 'expected' };
const sourceId = 'test-source', fallbackId = 'test-official', alternateId = 'test-alternate';
// CCSwitch's default card decides where a new conversation starts.
const setDefault = (directory, id) => atomicJSON(path.join(directory, 'live-state.json'), { apps: { codex: { mode: 'proxy', attached: true,
  proxy_route: id, stack: { enabled: false, members: [], keys: {} } } } });
// Company has no usable direct configuration, so only CCSwitch's default route
// reaches it; Alternate is a key-based relay the gateway connects to directly.
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoswitch-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await setDefault(directory, sourceId);
  await execute('sqlite3', [path.join(directory, 'cc-switch.db'), `CREATE TABLE providers(id TEXT,name TEXT,category TEXT,app_type TEXT,settings_config TEXT,meta TEXT);
    INSERT INTO providers VALUES
    ('${sourceId}','Company',NULL,'codex','{"auth":{"OPENAI_API_KEY":"synthetic-only"},"config":""}','{}'),
    ('${alternateId}','Alternate',NULL,'codex','{"auth":{"OPENAI_API_KEY":"synthetic-only"},"config":"openai_base_url = \\"https://alternate.example.invalid/v1\\""}','{}'),
    ('${fallbackId}','Official','official','codex','{"auth":{},"config":""}','{}');
    CREATE TABLE proxy_config(app_type TEXT,listen_address TEXT,listen_port INTEGER,auto_failover_enabled INTEGER);
    INSERT INTO proxy_config VALUES('codex','127.0.0.1',15721,0);`]);
  await configureGateway(directory, { backupName: 'Official', ccSwitchDirectory: directory });
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
// `primary` is the card the conversation started on (here CCSwitch's default route).
function evidenceState(config, primary = descriptor('primary', 'ccswitch')) {
  const state = newState(randomUUID());
  state.enabled = true; state.model = state.expected = 'expected'; state.epoch = 1;
  const backup = config?.backup || descriptor('personal', 'official');
  state.autoSwitch = { protocol: 3, approvalMode: 'per_incident', enabled: true, phase: 'armed', route: 'source', revision: 1,
    attempts: 0, configId: config?.id || randomUUID(), policyId: randomUUID(), primary, backup, current: primary };
  state.samples.push({ challenge: randomUUID(), at: Date.now(), epoch: 1, language: 'en', reportedModel: 'expected', expected: 'expected',
    expectedWeight: 0.01, prediction: 'other', outcome: 'difference_signal', fork: { routing: {
      route: 'source', providerId: primary.id, providerFingerprint: primary.fingerprint, transport: primary.transport, sourceKey: primary.key, ccswitchMode: 'default',
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
    ccswitchMode: target.transport === 'ccswitch' ? (target.key ? 'stack' : 'default') : null,
    proposalId: r.id, approvalId: r.approval.id, challenge: state.pending.id,
    threadId: randomUUID(), requestId: randomUUID(), finishedAt: Date.now(),
  } } };
}
// The user's next message after the report; consent commands require one.
async function userReplies(f) {
  const state = await readState(f.directory, f.session);
  await handleHook({ session_id: f.session, hook_event_name: 'UserPromptSubmit' }, f.directory, Math.max(Date.now(), state.lastUserReplyAt || 0) + 1);
}
async function pendingIncident(f) {
  await enable(f);
  await withState(f.directory, f.session, state => {
    const evidence = evidenceState(f.config, state.autoSwitch.primary).samples[0];
    evidence.fork.routing.policyId = state.autoSwitch.policyId;
    state.samples.push(evidence);
    assert.equal(queueAutoSwitch(state, Date.now(), evidence), true);
  });
  return (await readState(f.directory, f.session)).switchRequest;
}

test('a new thread starts on CCSwitch\'s default card, enable never changes it, and another thread has no monitor', async t => {
  const f = await fixture(t), sibling = randomUUID();
  const first = await resolveSessionRoute(f.directory, f.config, f.session);
  assert.equal(first.providerId, sourceId); assert.equal(first.ccswitchMode, 'default'); assert.equal(first.sourceKey, null);
  assert.equal((await readState(f.directory, f.session)).enabled, false);
  await assert.rejects(enableAutoSwitch(f.directory, f.session, readiness), /No recent successful request/);
  await enable(f);
  assert.equal((await resolveSessionRoute(f.directory, f.config, f.session)).providerId, sourceId);
  assert.equal((await resolveSessionRoute(f.directory, f.config, sibling)).providerId, sourceId);
  assert.equal((await readState(f.directory, sibling)).enabled, false);
  await assert.rejects(enable(f), /already has a route policy/);
  await withState(f.directory, f.session, state => { state.autoSwitch.enabled = false; });
  assert.equal((await resolveSessionRoute(f.directory, f.config, f.session)).providerId, sourceId);
});

test('a card only CCSwitch reaches rejects default drift and failover; new threads follow the new default', async t => {
  const f = await fixture(t);
  await enable(f);
  const before = await readState(f.directory, f.session);
  await execute('sqlite3', [path.join(f.directory, 'cc-switch.db'), "UPDATE proxy_config SET auto_failover_enabled=1 WHERE app_type='codex'"]);
  await assert.rejects(resolveSessionRoute(f.directory, f.config, f.session), /automatic failover/);
  await assert.rejects(resolveSessionRoute(f.directory, f.config, randomUUID()), /automatic failover/);
  await execute('sqlite3', [path.join(f.directory, 'cc-switch.db'), "UPDATE proxy_config SET auto_failover_enabled=0 WHERE app_type='codex'"]);
  await setDefault(f.directory, alternateId);
  await assert.rejects(resolveSessionRoute(f.directory, f.config, f.session), /default card changed/);
  const fresh = await resolveSessionRoute(f.directory, f.config, randomUUID());
  assert.equal(fresh.providerId, alternateId); assert.equal(fresh.transport, 'direct'); assert.equal(fresh.route, 'source');
  assert.deepEqual((await readState(f.directory, f.session)).autoSwitch, before.autoSwitch);
  const official = await resolveSessionRoute(f.directory, f.config, randomUUID(), fallbackId);
  assert.equal(official.transport, 'official'); assert.equal(official.ccswitchMode, null);
  const alternate = await resolveSessionRoute(f.directory, f.config, randomUUID(), alternateId);
  assert.equal(alternate.transport, 'direct'); assert.equal(alternate.ccswitchMode, null); assert.equal(alternate.providerId, alternateId);
  await assert.rejects(resolveSessionRoute(f.directory, f.config, randomUUID(), sourceId), /not CCSwitch's default card/);
});

test('a conversation keeps the card it started on; only new conversations follow CCSwitch\'s default card', async t => {
  const f = await fixture(t), started = randomUUID();
  await setDefault(f.directory, alternateId);
  const first = await resolveSessionRoute(f.directory, f.config, started);
  assert.equal(first.providerId, alternateId); assert.equal(first.transport, 'direct'); assert.equal(first.route, 'source');
  await setDefault(f.directory, sourceId);
  const again = await resolveSessionRoute(f.directory, f.config, started);
  assert.equal(again.providerId, alternateId); assert.equal(again.transport, 'direct');
  const fresh = await resolveSessionRoute(f.directory, f.config, randomUUID());
  assert.equal(fresh.providerId, sourceId); assert.equal(fresh.ccswitchMode, 'default');
  // Without CCSwitch's proxy no default card is defined, but a direct conversation goes on.
  await atomicJSON(path.join(f.directory, 'live-state.json'), { apps: { codex: { mode: 'direct', attached: false } } });
  assert.equal((await resolveSessionRoute(f.directory, f.config, started)).providerId, alternateId);
  await assert.rejects(resolveSessionRoute(f.directory, f.config, randomUUID()), /local proxy/);
});

test('switching without monitoring creates a routing-only policy; monitoring starts only when asked', async t => {
  const f = await fixture(t);
  const route = await resolveSessionRoute(f.directory, f.config, f.session);
  await saveReceipt(f.directory, f.config, receipt(f.session, route));
  await assert.rejects(requestManualSwitch(f.directory, f.session, { name: 'Alternate' }, readiness), /user's reply/);
  assert.ok(!(await readState(f.directory, f.session)).autoSwitch, 'a refused switch leaves no policy behind');
  await userReplies(f);
  const request = await requestManualSwitch(f.directory, f.session, { name: 'Alternate' }, readiness);
  assert.equal(request.target.id, alternateId); assert.equal(request.previous.enabled, false);
  const state = await readState(f.directory, f.session);
  assert.equal(state.autoSwitch.primary.id, sourceId); assert.equal(state.pending.kind, 'fallback_verification');
  finishVerification(state, canary(state), state.pending, Date.now());
  assert.equal(state.switchRequest.status, 'succeeded'); assert.equal(state.autoSwitch.current.id, alternateId);
  assert.equal(state.autoSwitch.route, 'fallback'); assert.equal(state.enabled, false, 'switching never starts monitoring');
  assert.equal(state.monitoringStoppedReason, 'routing_only'); assert.equal(state.pending, null); assert.equal(state.taskHalt, null);
  await withState(f.directory, f.session, s => Object.assign(s, state));
  await assert.rejects(enableAutoSwitch(f.directory, f.session, readiness), /already has a route policy/);
  const resumed = await resumeMonitoring(f.directory, f.session, readiness);
  assert.equal(resumed.current.id, alternateId); assert.equal(resumed.enabled, true);
  const monitored = await readState(f.directory, f.session);
  assert.equal(monitored.enabled, true); assert.equal(monitored.monitoringStoppedReason, null); assert.equal(monitored.forceProbe, true);
});

// One user-requested switch whose canary passes.
async function switchTo(f, name) {
  await userReplies(f);
  await requestManualSwitch(f.directory, f.session, { name }, readiness);
  await withState(f.directory, f.session, state => { finishVerification(state, canary(state), state.pending, Date.now()); });
  return readState(f.directory, f.session);
}

// What the agent is told after a successful switch, and what the list promises.
const switchNotice = async f => (await handleBackgroundHook({ session_id: f.session, hook_event_name: 'PostToolUse', tool_name: 'Bash',
  tool_use_id: randomUUID() }, f.directory, {})).hookSpecificOutput?.additionalContext || '';
const afterSwitch = async (f, id) => (await listSwitchCandidates(f.directory, f.session)).candidates.find(entry => entry.id === id).monitoringAfterSwitch;

test('monitoring the user never enabled stays off through Official and back; monitoring paused for Official resumes', async t => {
  const f = await fixture(t);
  await saveReceipt(f.directory, f.config, receipt(f.session, await resolveSessionRoute(f.directory, f.config, f.session)));
  let state = await switchTo(f, 'Official');
  assert.equal(state.autoSwitch.current.transport, 'official'); assert.equal(state.monitoringStoppedReason, 'routing_only');
  assert.match(await switchNotice(f), /Fingerprint monitoring is off on the personal subscription/);
  assert.equal(await afterSwitch(f, alternateId), 'stays_off');
  state = await switchTo(f, 'Company');
  assert.equal(state.autoSwitch.current.id, sourceId); assert.equal(state.autoSwitch.route, 'source');
  assert.equal(state.enabled, false); assert.equal(state.monitoringStoppedReason, 'routing_only');
  assert.match(await switchNotice(f), /Fingerprint monitoring stays off on this route/);
  const g = await fixture(t);
  await enable(g);
  // No routine checkpoint falls due while the user asks for the switches.
  await withState(g.directory, g.session, s => { s.forceProbe = false; s.nextTools = Number.MAX_SAFE_INTEGER; });
  state = await switchTo(g, 'Official');
  assert.equal(state.enabled, false); assert.equal(state.monitoringStoppedReason, 'personal_route');
  await switchNotice(g);
  assert.equal(await afterSwitch(g, alternateId), 'continues', 'the list promises what switching back does');
  state = await switchTo(g, 'Alternate');
  assert.equal(state.autoSwitch.current.transport, 'direct'); assert.equal(state.enabled, true, 'monitoring resumes on a third-party route');
  assert.match(await switchNotice(g), /Monitoring continues on the selected third-party route/);
});

test('switching leaves standalone monitoring alone, and a refused switch leaves the thread as it was', async t => {
  const f = await fixture(t);
  await saveReceipt(f.directory, f.config, receipt(f.session, await resolveSessionRoute(f.directory, f.config, f.session)));
  await userReplies(f);
  // Official needs a ChatGPT login: refused before a routing-only policy exists.
  const before = await readFile(sessionPath(f.directory, f.session), 'utf8');
  await assert.rejects(requestManualSwitch(f.directory, f.session, { name: 'Official' }, { ...readiness, accountType: 'apiKey' }), /ChatGPT/);
  await assert.rejects(requestManualSwitch(f.directory, f.session, { name: 'Company' }, readiness), /already uses/);
  assert.equal(await readFile(sessionPath(f.directory, f.session), 'utf8'), before);
  // Standalone monitoring (guard start) is not silently turned into a routing policy.
  await withState(f.directory, f.session, s => { s.enabled = true; s.expected = 'explicit-label'; s.expectedSource = 'explicit'; });
  const monitored = await readFile(sessionPath(f.directory, f.session), 'utf8');
  await assert.rejects(requestManualSwitch(f.directory, f.session, { name: 'Alternate' }, readiness), /standalone monitoring/);
  assert.equal(await readFile(sessionPath(f.directory, f.session), 'utf8'), monitored);
});

test('a thread monitored without a route policy is probed on the card it started on', async t => {
  const f = await fixture(t);
  await setDefault(f.directory, alternateId);
  const route = await resolveSessionRoute(f.directory, f.config, f.session);
  assert.equal(route.providerId, alternateId);
  await setDefault(f.directory, sourceId); // new conversations now start elsewhere
  const pending = { id: randomUUID(), epoch: 1, at: Date.now(), expiresAt: Date.now() + 60000 };
  await withState(f.directory, f.session, s => { s.enabled = true; s.epoch = 1; s.pending = pending; });
  const transport = await prepareSwitchTransport(f.directory, { id: randomUUID(), sourceSession: f.session, provider: 'openai' }, pending);
  assert.ok(transport, 'the probe is bound to the gateway route of this thread');
  const fork = randomUUID();
  await transport.authorize(fork);
  const probe = await resolveSessionRoute(f.directory, f.config, fork);
  assert.equal(probe.providerId, alternateId); assert.equal(probe.transport, 'direct');
  assert.equal(probe.revision, 0); assert.equal(probe.challenge, pending.id);
  await withState(f.directory, f.session, s => { s.pending = null; });
  await assert.rejects(resolveSessionRoute(f.directory, f.config, fork), /live checkpoint/);
  await transport.close();
});

test('turning monitoring on again after a disabled incident lets later incidents ask again', async t => {
  const f = await fixture(t), r = await pendingIncident(f);
  await runAutoSwitch(['disable', '--session', f.session, '--data-dir', f.directory], {});
  await userReplies(f);
  await run(['resume', '--session', f.session, '--data-dir', f.directory, '--halt', r.haltId], {});
  assert.equal((await readState(f.directory, f.session)).autoSwitch.phase, 'failed');
  await resumeMonitoring(f.directory, f.session, readiness);
  const state = await readState(f.directory, f.session);
  assert.equal(state.enabled, true); assert.equal(state.autoSwitch.phase, 'armed');
  const sample = evidenceState(f.config, state.autoSwitch.current).samples[0];
  Object.assign(sample, { epoch: state.epoch });
  Object.assign(sample.fork.routing, { policyId: state.autoSwitch.policyId, configId: state.autoSwitch.configId, revision: state.autoSwitch.revision });
  assert.equal(eligibleForSwitch(state, sample), true);
});

test('a switch for a model the fingerprint bank lacks is refused before anything starts', async t => {
  const f = await fixture(t);
  await saveReceipt(f.directory, f.config, receipt(f.session, await resolveSessionRoute(f.directory, f.config, f.session)));
  await userReplies(f);
  const before = await readFile(sessionPath(f.directory, f.session), 'utf8');
  // A stand-in Codex app-server reporting a model label that is not in the bank.
  await writeFile(path.join(f.directory, 'app-server'), `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  const result = request.method === 'account/read' ? { account: { type: 'chatgpt' } }
    : request.method === 'thread/read' ? { thread: { id: request.params.threadId, path: ${JSON.stringify(path.join(f.directory, 'rollout.jsonl'))}, ephemeral: false,
      model: 'model-not-in-bank', modelProvider: 'openai', reasoningEffort: 'high', cwd: ${JSON.stringify(f.directory)} } }
    : request.method === 'hooks/list' ? { data: [] } : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});\n`);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guard.mjs'), 'switch-route', '--session', f.session,
    '--data-dir', f.directory, '--target-name', 'Alternate'], { cwd: f.directory, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, MODELTRACE_CODEX_PATH: process.execPath, CODEX_THREAD_ID: f.session } });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stderr.trim()).code, 'MODEL_NOT_IN_BANK');
  assert.equal(await readFile(sessionPath(f.directory, f.session), 'utf8'), before, 'no policy, pause or probe was started');
});

test('monitoring never resumes on personal Official', async t => {
  const f = await fixture(t);
  await setDefault(f.directory, fallbackId);
  const route = await resolveSessionRoute(f.directory, f.config, f.session);
  assert.equal(route.transport, 'official');
  await saveReceipt(f.directory, f.config, receipt(f.session, route));
  await assert.rejects(enableAutoSwitch(f.directory, f.session, readiness), /personal Official/);
  await enableAutoSwitch(f.directory, f.session, readiness, { monitor: false });
  await assert.rejects(resumeMonitoring(f.directory, f.session, readiness), /personal Official/);
  assert.equal((await readState(f.directory, f.session)).enabled, false);
});

test('only a valid current-route mismatch can request consent, including a clearly labelled weak disagreement', () => {
  assert.equal(eligibleForSwitch(evidenceState()), true);
  const weak = evidenceState(); weak.samples[0].outcome = 'inconclusive'; assert.equal(eligibleForSwitch(weak), true);
  for (const mutate of [s => { s.samples[0].fork.routing.success = false; }, s => { s.samples[0].fork.routing.completed = false; },
    s => { s.samples[0].fork.routing.providerId = 'other'; }, s => { s.samples[0].fork.routing.providerFingerprint = 'old'; },
    s => { s.samples[0].fork.routing.revision = 0; }, s => { s.samples[0].fork.routing.configId = 'old'; },
    s => { s.samples[0].fork.routing.ccswitchMode = 'stack'; }, s => { delete s.samples[0].fork.routing.ccswitchMode; },
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
  await assert.rejects(approveSwitch(f.directory, f.session, r.id, r.target.id, readiness), /user's reply/);
  await userReplies(f);
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
  await userReplies(f);
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
  await assert.rejects(declineSwitch(f.directory, f.session, r.id), /user's reply/);
  await userReplies(f);
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

test('a target candidate inside the validated confusable group verifies; a forged or out-of-group label does not', () => {
  const group = { id: 'expected~sibling', models: ['expected', 'sibling'], groupWeight: 0.52 };
  const ok = approvedState(), okCheckpoint = ok.pending;
  finishVerification(ok, { ...canary(ok), prediction: 'sibling', confusableGroup: group }, okCheckpoint, Date.now());
  assert.equal(ok.switchRequest.status, 'succeeded'); assert.equal(ok.taskHalt, null);
  for (const mutate of [sample => { delete sample.confusableGroup; }, sample => { sample.prediction = 'other'; },
    sample => { sample.confusableGroup = { ...group, models: ['sibling', 'other'] }; }, sample => { sample.outcome = 'inconclusive'; }]) {
    const state = approvedState(), checkpoint = state.pending, sample = { ...canary(state), prediction: 'sibling', confusableGroup: group };
    mutate(sample);
    finishVerification(state, sample, checkpoint, Date.now());
    assert.ok(state.taskHalt); assert.equal(state.autoSwitch.phase, 'failed');
  }
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
  await userReplies(f);
  await approveSwitch(f.directory, f.session, r.id, r.target.id, readiness);
  await withState(f.directory, f.session, state => abandon(state, Date.now(), 'test_target_unavailable'));
  const fresh = await proposeSwitch(f.directory, f.session, r.id, { name: 'Alternate' });
  assert.notEqual(fresh.id, r.id); assert.equal(fresh.approval, null);
  await assert.rejects(approveSwitch(f.directory, f.session, r.id, fallbackId, readiness));
  await assert.rejects(approveSwitch(f.directory, f.session, fresh.id, alternateId, readiness), /user's reply/, 'one reply settles one decision');
  await userReplies(f);
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
  await userReplies(f);
  await approveSwitch(f.directory, f.session, r.id, r.target.id, readiness);
  await handleHook({ session_id: f.session, hook_event_name: 'Interrupt', turn_id: 'turn-a' }, f.directory);
  const stopped = await readState(f.directory, f.session);
  assert.equal(stopped.switchRequest.status, 'failed'); assert.ok(stopped.taskHalt);
  assert.equal(stopped.pending, null); assert.equal(beginVerification(stopped, Date.now()), false);
  const command = `node '${ROOT}/scripts/guard.mjs' approve-switch --request '${r.id}' --target-provider '${r.target.id}'`;
  assert.equal(isControlCommand({ tool_name: 'Bash', tool_input: { command } }), true);
  assert.equal(isControlCommand({ tool_name: 'Bash', tool_input: { command: command + '; touch bypass' } }), false);
});

test('the agent cannot consent within its own turn; only a later user reply settles one decision', async t => {
  const f = await fixture(t), r = await pendingIncident(f);
  await withState(f.directory, f.session, state => { state.alerts.push({ id: r.haltId, acknowledgedAt: null }); });
  const prompt = (now, extra = {}) => handleHook({ session_id: f.session, hook_event_name: 'UserPromptSubmit', ...extra }, f.directory, now);
  const early = Date.now();
  await delay(5);
  await run(['acknowledge', '--session', f.session, '--data-dir', f.directory, '--alert', r.haltId], {});
  // Same turn: report, acknowledge, then try to decide without the user.
  for (const decide of [() => approveSwitch(f.directory, f.session, r.id, r.target.id, readiness), () => declineSwitch(f.directory, f.session, r.id)]) {
    await assert.rejects(decide(), /user's reply/);
  }
  // A prompt whose hook started before the acknowledgement, processed late, is not a reply to it.
  await prompt(early);
  await assert.rejects(approveSwitch(f.directory, f.session, r.id, r.target.id, readiness), /user's reply/);
  // A parent agent's instruction to a subagent is not a user reply.
  await prompt(Date.now() + 1, { agent_id: randomUUID(), agent_type: 'worker' });
  await assert.rejects(approveSwitch(f.directory, f.session, r.id, r.target.id, readiness), /user's reply/);
  // A blocking request_user_input answer is a user reply.
  await handleHook({ session_id: f.session, hook_event_name: 'PostToolUse', tool_name: 'request_user_input', tool_use_id: randomUUID() }, f.directory, Date.now() + 2);
  await approveSwitch(f.directory, f.session, r.id, r.target.id, readiness);
  const state = await readState(f.directory, f.session);
  assert.equal(state.switchRequest.status, 'verifying'); assert.equal(state.userDecisionAt, state.lastUserReplyAt);
});

test('subagents share the root pause and cannot keep working while the user is asked', async t => {
  const f = await fixture(t);
  const subagent = { session_id: f.session, agent_id: randomUUID(), agent_type: 'worker', hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'edit' } };
  assert.deepEqual(await handleHook(subagent, f.directory), {}, 'no state: subagents are untouched');
  await enable(f);
  assert.deepEqual(await handleHook(subagent, f.directory), {}, 'monitoring without a pause does not block subagents');
  await withState(f.directory, f.session, state => {
    const evidence = evidenceState(f.config, state.autoSwitch.primary).samples[0];
    evidence.fork.routing.policyId = state.autoSwitch.policyId;
    state.samples.push(evidence);
    assert.equal(queueAutoSwitch(state, Date.now(), evidence), true);
  });
  const r = (await readState(f.directory, f.session)).switchRequest, before = await readFile(sessionPath(f.directory, f.session), 'utf8');
  for (const event of [subagent, { ...subagent, session_id: randomUUID(), agent_id: undefined, parent_session_id: f.session },
    { ...subagent, tool_name: 'Bash', tool_input: { command: `node '${ROOT}/scripts/guard.mjs' approve-switch --request '${r.id}' --target-provider '${r.target.id}'` } }]) {
    const result = await handleHook(event, f.directory);
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /parent task is paused/);
  }
  // The native hook runner exposes the subagent's own thread as CODEX_THREAD_ID.
  const hook = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guard.mjs'), 'hook'], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, MODELTRACE_AUTOSWITCH_DATA: f.directory, CODEX_THREAD_ID: subagent.agent_id, MODELTRACE_PROBE_PROCESS: '0' }, input: JSON.stringify(subagent) });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(await handleHook({ ...subagent, hook_event_name: 'PostToolUse' }, f.directory), {});
  assert.equal(await readFile(sessionPath(f.directory, f.session), 'utf8'), before, 'subagent hooks never write root state');
});
