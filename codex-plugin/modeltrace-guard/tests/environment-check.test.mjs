import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEnvironment } from '../scripts/environment-check.mjs';

const primary = { id: 'company', name: 'API2 copy', fingerprint: 'a'.repeat(64), transport: 'ccswitch', key: null };
const official = { id: 'official', name: 'OpenAI Official', fingerprint: 'b'.repeat(64), transport: 'official', key: null };
const config = { id: '11111111-1111-4111-8111-111111111111', primary, backup: official, port: 15722, ccSwitchDirectory: '/fixture/cc-switch' };
const row = (id, name, extra = {}) => ({ id, name, category: null, fingerprint: id === 'company' ? 'a'.repeat(64) : id === 'official' ? 'b'.repeat(64) : 'c'.repeat(64),
  nativeOfficial: 0, followsNativeLogin: 0, managedCodexAccount: 0, delegatedAuth: 0, ...extra });
const layout = (extra = {}) => ({ providers: [row('company', 'API2 copy'), row('doro', 'Doro'),
  row('official', 'OpenAI Official', { category: 'official', nativeOfficial: 1, followsNativeLogin: 1 })],
  mode: 'proxy', attached: true, pending: false, defaultProvider: 'company', stack: { enabled: false, members: [], keys: {} },
  listener: { listen_address: '127.0.0.1', listen_port: 15721, auto_failover_enabled: 0 }, ...extra });
const client = (account = { type: 'chatgpt', email: 'private@example.invalid' }) => async () => ({
  request: async method => { assert.equal(method, 'account/read'); return { account }; }, close: async () => {} });
const healthy = {
  nodeVersion: '24.11.1', runtimeProblem: () => null, sqlite: async () => null, openClient: client(), trustCheck: async () => {},
  inspect: async () => layout(), loadConfig: async () => config, gatewayStatus: async () => ({ running: true, readiness: 'ready' }),
  integration: async () => ({ phase: 'installed', readyForNewThreads: true }),
  readCards: async () => new Map([['doro', { problem: null, connection: { key: 'sk-secret-should-not-leak' } }]]),
};
const status = result => Object.fromEntries(result.checks.map(check => [check.id, check.status]));

test('a complete setup is ready and lists its switch targets', async () => {
  const result = await checkEnvironment('/data', {}, healthy);
  assert.equal(result.ready, true); assert.equal(result.next, null);
  assert.deepEqual(status(result), { node: 'ok', sqlite3: 'ok', codex: 'ok', login: 'ok', hooks: 'ok', ccswitch: 'ok', ccswitch_proxy: 'ok',
    primary: 'ok', primary_default: 'ok', failover: 'ok', gateway: 'ok', connection: 'ok', routes: 'ok' });
  assert.match(result.checks.find(check => check.id === 'routes').summary, /OpenAI Official, Doro/);
  assert.ok(!JSON.stringify(result).includes('sk-secret-should-not-leak'));
  assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
});

test('a new user sees the setup steps still to do, first one first', async () => {
  const result = await checkEnvironment('/data', {}, { ...healthy, loadConfig: async () => { throw new Error('missing'); },
    trustCheck: async () => { throw new Error('untrusted'); }, integration: async () => assert.fail('no configuration yet') });
  assert.equal(result.ready, false);
  assert.deepEqual(status(result), { node: 'ok', sqlite3: 'ok', codex: 'ok', login: 'ok', hooks: 'todo', ccswitch: 'ok', ccswitch_proxy: 'ok',
    primary: 'todo', gateway: 'skip', connection: 'skip' });
  assert.match(result.next, /\/hooks/);
  assert.match(result.checks.find(check => check.id === 'primary').fix, /主渠道用/);
});

test('missing tools and an unreadable CCSwitch each say how to fix them, and dependent items are skipped', async () => {
  const result = await checkEnvironment('/data', {}, { ...healthy, runtimeProblem: () => 'old node', sqlite: async () => 'sqlite3 is not installed or not on PATH',
    openClient: async () => { throw new Error('ENOENT codex'); }, inspect: async () => { throw new Error('no db'); }, loadConfig: async () => { throw new Error('missing'); } });
  assert.deepEqual(status(result), { node: 'fail', sqlite3: 'fail', codex: 'fail', login: 'skip', hooks: 'skip', ccswitch: 'fail', ccswitch_proxy: 'skip',
    primary: 'todo', gateway: 'skip', connection: 'skip' });
  for (const id of ['node', 'sqlite3', 'codex', 'ccswitch']) assert.ok(result.checks.find(check => check.id === id).fix, id);
  assert.match(result.next, /Node\.js/);
});

test('CCSwitch drift, a stale gateway and a rewritten Codex config are reported with their repair', async () => {
  const result = await checkEnvironment('/data', {}, { ...healthy, openClient: client({ type: 'apiKey' }),
    inspect: async () => layout({ mode: 'direct', defaultProvider: 'doro', listener: { listen_port: 15721, auto_failover_enabled: 1 } }),
    gatewayStatus: async () => ({ running: true, readiness: 'upgrade_required' }), integration: async () => ({ phase: 'conflict', readyForNewThreads: false }) });
  const by = id => result.checks.find(check => check.id === id);
  assert.equal(by('login').status, 'fail'); assert.match(by('login').fix, /codex login/);
  assert.equal(by('ccswitch_proxy').status, 'fail'); assert.match(by('ccswitch_proxy').fix, /Routing or Aggregation/);
  assert.equal(by('primary_default').status, 'fail'); assert.match(by('primary_default').fix, /API2 copy/);
  assert.equal(by('failover').status, 'fail');
  assert.equal(by('gateway').status, 'fail'); assert.match(by('gateway').fix, /gateway-stop, then gateway-start/);
  assert.equal(by('connection').status, 'fail'); assert.match(by('connection').fix, /重新接入/);
});

test('a missing primary card and no usable target are not reported as ready', async () => {
  const result = await checkEnvironment('/data', {}, { ...healthy, inspect: async () => layout({ providers: [row('company', 'API2 copy')] }),
    loadConfig: async () => ({ ...config, primary: { ...primary, fingerprint: 'd'.repeat(64) } }) });
  assert.equal(result.checks.find(check => check.id === 'primary').status, 'fail');
  assert.equal(result.checks.find(check => check.id === 'routes').status, 'todo');
  assert.equal(result.ready, false);
});
