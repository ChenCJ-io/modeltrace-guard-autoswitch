import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { abandon, newState, readState, withState } from '../scripts/state.mjs';
import { controlContext, handleHook } from '../scripts/guard.mjs';
import {
  atomicJSON, beginVerification, configureGateway, eligibleForSwitch, enableAutoSwitch,
  failAutoSwitch, finishVerification, haltBlocksProbe, inspectCCSwitch, loadGatewayConfig,
  prepareSwitchTransport, queueAutoSwitch, resolveSessionRoute, saveReceipt, validateGatewayConfig, verifyLayout,
} from '../scripts/switch-policy.mjs';

const execute = promisify(execFile);
const sourceId = 'test-source', fallbackId = 'test-official';
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoswitch-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = { version: 1, apps: { codex: { mode: 'proxy', attached: true, proxy_route: fallbackId,
    stack: { enabled: true, members: [sourceId], keys: { company: sourceId } } } } };
  await atomicJSON(path.join(directory, 'live-state.json'), live);
  await execute('sqlite3', [path.join(directory, 'cc-switch.db'), `CREATE TABLE providers(id TEXT,name TEXT,category TEXT,app_type TEXT,settings_config TEXT,meta TEXT);
    INSERT INTO providers VALUES('${sourceId}','Company',NULL,'codex','{"auth":{"OPENAI_API_KEY":"synthetic-only"},"config":""}','{}'),('${fallbackId}','Official','official','codex','{"auth":{},"config":""}','{}');
    CREATE TABLE proxy_config(app_type TEXT,listen_address TEXT,listen_port INTEGER);
    INSERT INTO proxy_config VALUES('codex','127.0.0.1',15721);`]);
  await configureGateway(directory, { sourceProvider: sourceId, fallbackProvider: fallbackId, ccSwitchDirectory: directory });
  const config = await loadGatewayConfig(directory), session = randomUUID();
  return { directory, config, session, live };
}
const receipt = (session, overrides = {}) => ({ threadId: session, requestId: randomUUID(), route: 'fallback', revision: 0,
  completed: true, success: true, responseEvent: 'response.completed', statusCode: 200, startedAt: Date.now() - 10, finishedAt: Date.now(), ...overrides });
async function enable(f) {
  await saveReceipt(f.directory, f.config, receipt(f.session));
  return enableAutoSwitch(f.directory, f.session, { accountType: 'chatgpt', modelProvider: 'openai', model: 'gpt-6-astra' });
}
function evidenceState() {
  const state = newState(randomUUID());
  state.enabled = true; state.model = state.expected = 'expected'; state.epoch = 1;
  state.autoSwitch = { enabled: true, phase: 'armed', route: 'source', revision: 1, attempts: 0, configId: randomUUID(), policyId: randomUUID() };
  state.confirmation = { id: 'initial', allMismatch: true, status: 'completed', expected: 'expected', epoch: 1, language: 'en', target: 3,
    results: [1, 2, 3].map(n => ({ challenge: `retry-${n}`, mismatch: true, prediction: 'other' })) };
  state.taskHalt = { id: 'initial', expected: 'expected', retryCount: 3 };
  for (const id of ['initial', 'retry-1', 'retry-2', 'retry-3']) state.samples.push({ challenge: id, epoch: 1, expected: 'expected', prediction: 'other', outcome: 'difference_signal',
    fork: { routing: { route: 'source', success: true, configId: state.autoSwitch.configId, policyId: state.autoSwitch.policyId, revision: 1 } } });
  return state;
}
function canary(state, overrides = {}) {
  return { expected: 'expected', prediction: 'expected', outcome: 'compatible',
    fork: { routing: { route: 'fallback', success: true, configId: state.autoSwitch.configId, policyId: state.autoSwitch.policyId,
      revision: 2, threadId: randomUUID(), requestId: randomUUID(), finishedAt: Date.now(), ...overrides } } };
}

test('inspection contains only provider identities and verifies the actual stack registry', async t => {
  const f = await fixture(t), layout = await inspectCCSwitch(f.directory);
  assert.deepEqual(Object.keys(layout.providers[0]), ['id', 'name', 'category', 'fingerprint', 'nativeOfficial']);
  assert.ok(!JSON.stringify(layout).includes('synthetic-only'));
  assert.equal(verifyLayout(f.config, layout), true);
  for (const changed of [ { mode: 'direct' }, { attached: false }, { pending: true }, { defaultProvider: 'wrong' },
    { stack: { ...layout.stack, members: [] } }, { stack: { ...layout.stack, keys: { company: 'wrong' } } },
    { listener: { listen_address: '0.0.0.0', listen_port: 15721 } } ]) {
    assert.throws(() => verifyLayout(f.config, { ...layout, ...changed }));
  }
  assert.throws(() => validateGatewayConfig({ ...f.config, upstream: 'http://example.com/v1' }));
  assert.throws(() => validateGatewayConfig({ ...f.config, upstream: 'http://127.0.0.1:15722/v1' }));
});

test('an official label cannot hide API credentials, a third-party endpoint or subsequent provider edits', async t => {
  const f = await fixture(t);
  for (const config of [ { auth: { OPENAI_API_KEY: 'test-secret' }, config: '' },
    { auth: {}, config: 'model_provider = "custom"' }, { auth: {}, config: '', base_url: 'https://example.invalid/v1' } ]) {
    const sql = `UPDATE providers SET settings_config='${JSON.stringify(config).replaceAll("'", "''")}' WHERE id='${fallbackId}';`;
    await execute('sqlite3', [path.join(f.directory, 'cc-switch.db'), sql]);
    const layout = await inspectCCSwitch(f.directory);
    assert.equal(layout.providers.find(p => p.id === fallbackId).nativeOfficial, 0);
    assert.throws(() => verifyLayout(f.config, layout), /pristine native/);
    assert.ok(!JSON.stringify(layout).includes('test-secret'));
  }
  await execute('sqlite3', [path.join(f.directory, 'cc-switch.db'), `UPDATE providers SET settings_config='{"auth":{},"config":""}',meta='{"authBinding":{"accountId":"different"}}' WHERE id='${fallbackId}';`]);
  const changed = await inspectCCSwitch(f.directory);
  assert.throws(() => verifyLayout(f.config, changed), /changed/);
});

test('enabling is explicit, per thread, persistent, and cannot be silently rearmed', async t => {
  const f = await fixture(t), sibling = randomUUID();
  assert.equal((await resolveSessionRoute(f.directory, f.config, f.session)).route, 'fallback');
  await assert.rejects(enableAutoSwitch(f.directory, f.session, { accountType: 'chatgpt', modelProvider: 'openai', model: 'gpt-6-astra' }), /successful official/);
  await enable(f);
  assert.equal((await resolveSessionRoute(f.directory, f.config, f.session)).route, 'source');
  assert.equal((await resolveSessionRoute(f.directory, f.config, sibling)).route, 'fallback');
  assert.equal((await readState(f.directory, f.session)).config.retryCount, 3);
  await assert.rejects(enable(f), /already has a route policy/);
  await assert.rejects(enableAutoSwitch(f.directory, sibling, { accountType: 'apikey', modelProvider: 'openai' }), /ChatGPT/);
  await withState(f.directory, f.session, s => { s.autoSwitch.enabled = false; });
  assert.equal((await resolveSessionRoute(f.directory, f.config, f.session)).route, 'source', 'disabling policy never silently switches back');
});

test('weak evidence, wrong route, missing retries and stale route versions cannot authorize a switch', () => {
  assert.equal(eligibleForSwitch(evidenceState()), true);
  for (const mutate of [ s => { s.samples[0].outcome = 'inconclusive'; }, s => { s.samples[1].fork.routing.success = false; },
    s => { s.samples[2].fork.routing.route = 'fallback'; }, s => { s.samples[3].fork.routing.revision = 0; },
    s => { s.samples[3].fork.routing.configId = 'old'; }, s => { s.confirmation.target = 2; }, s => { s.autoSwitch.enabled = false; },
    s => { s.samples.pop(); }, s => { s.autoSwitch.attempts = 1; } ]) {
    const state = evidenceState(); mutate(state); assert.equal(eligibleForSwitch(state), false);
  }
});

test('one verified fallback changes only the route and retains thread, history, and original work', () => {
  const state = evidenceState(), originalSession = state.session, history = structuredClone(state.samples);
  assert.equal(queueAutoSwitch(state, 100), true);
  assert.match(controlContext(state, '/tmp/fixture'), /authorized one automatic/);
  state.alerts.push({ id: 'last', acknowledgedAt: null });
  assert.equal(beginVerification(state, 110), false, 'user notification remains mandatory');
  state.alerts[0].acknowledgedAt = 110;
  assert.equal(beginVerification(state, 120), true);
  assert.equal(haltBlocksProbe(state), false);
  assert.ok(state.taskHalt, 'verification does not clear the halt');
  assert.equal(state.autoSwitch.route, 'source', 'parent route is not committed before verification');
  assert.equal(beginVerification(state, 121), false);
  const checkpoint = state.pending;
  finishVerification(state, canary(state), checkpoint, 130);
  assert.equal(state.taskHalt, null); assert.equal(state.autoSwitch.phase, 'switched');
  assert.equal(state.autoSwitch.route, 'fallback'); assert.equal(state.autoSwitch.revision, 2);
  assert.equal(state.session, originalSession); assert.deepEqual(state.samples, history);
  assert.equal(queueAutoSwitch(state, 140), false, 'no recursive failover');
});

test('a 200 response without successful native completion, mismatched fingerprint, interruption or wrong receipt keeps halt', () => {
  for (const mutate of [ (s, sample) => { sample.fork.routing.success = false; }, (s, sample) => { sample.prediction = 'other'; },
    (s, sample) => { sample.outcome = 'inconclusive'; }, (s, sample) => { sample.fork.routing.revision = 1; },
    s => { s.runtimePaused = true; }, s => { s.autoSwitch.enabled = false; }, s => { s.taskHalt.id = 'another-halt'; } ]) {
    const state = evidenceState(); queueAutoSwitch(state, 100); beginVerification(state, 110);
    const sample = canary(state); mutate(state, sample);
    finishVerification(state, sample, state.pending, 120);
    assert.ok(state.taskHalt); assert.equal(state.autoSwitch.phase, 'failed'); assert.equal(state.autoSwitch.route, 'source');
  }
  const state = evidenceState(); queueAutoSwitch(state, 100); beginVerification(state, 110); abandon(state, 120, 'expired');
  assert.equal(state.autoSwitch.phase, 'failed'); assert.equal(haltBlocksProbe(state), true);
});

test('fork bindings pin source and fallback probes to the exact live policy and real completion receipt', async t => {
  const f = await fixture(t); await enable(f);
  const challenge = randomUUID(), fork = randomUUID(), snapshot = { id: randomUUID(), sourceSession: f.session, provider: 'openai' };
  const pending = { id: challenge, at: Date.now(), expiresAt: Date.now() + 60000 };
  await withState(f.directory, f.session, s => { s.pending = pending; });
  const transport = await prepareSwitchTransport(f.directory, snapshot, pending);
  await assert.rejects(transport.authorize(f.session), /disposable/);
  await transport.authorize(fork);
  assert.equal((await resolveSessionRoute(f.directory, f.config, fork)).route, 'source');
  await assert.rejects(transport.receipt(), /No completed/);
  await saveReceipt(f.directory, f.config, receipt(fork, { route: 'source', revision: 1, startedAt: pending.at }));
  assert.equal((await transport.receipt()).policyId, (await readState(f.directory, f.session)).autoSwitch.policyId);
  await withState(f.directory, f.session, s => { s.pending.id = randomUUID(); });
  await assert.rejects(resolveSessionRoute(f.directory, f.config, fork), /live checkpoint/);
  await transport.close();
});

test('user interruption of queued recovery prevents background continuation but preserves evidence', async t => {
  const f = await fixture(t), state = evidenceState(); state.session = f.session;
  queueAutoSwitch(state, Date.now());
  await withState(f.directory, f.session, s => Object.assign(s, state));
  await handleHook({ session_id: f.session, hook_event_name: 'Interrupt', turn_id: 'turn-a' }, f.directory);
  const stopped = await readState(f.directory, f.session);
  assert.equal(stopped.autoSwitch.phase, 'failed'); assert.ok(stopped.taskHalt);
  assert.equal(stopped.samples.length, 4); assert.equal(beginVerification(stopped, Date.now()), false);
});
