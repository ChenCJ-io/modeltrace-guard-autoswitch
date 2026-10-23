import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkEnvironment } from '../scripts/environment-check.mjs';

const official = { id: 'official', name: 'OpenAI Official', fingerprint: 'b'.repeat(64), transport: 'official', key: null };
const config = { id: '11111111-1111-4111-8111-111111111111', backup: official, port: 15722, ccSwitchDirectory: '/fixture/cc-switch' };
const fingerprints = { company: 'a'.repeat(64), official: 'b'.repeat(64), doro: 'c'.repeat(64), work: 'e'.repeat(64) };
const row = (id, name, extra = {}) => ({ id, name, category: null, fingerprint: fingerprints[id],
  nativeOfficial: 0, followsNativeLogin: 0, managedCodexAccount: 0, delegatedAuth: 0, ...extra });
const layout = (extra = {}) => ({ providers: [row('company', 'API2 copy'), row('doro', 'Doro'),
  row('official', 'OpenAI Official', { category: 'official', nativeOfficial: 1, followsNativeLogin: 1 }),
  row('work', 'Work ChatGPT', { category: 'official', managedCodexAccount: 1 })],
  mode: 'proxy', attached: true, pending: false, defaultProvider: 'company', stack: { enabled: false, members: [], keys: {} },
  listener: { listen_address: '127.0.0.1', listen_port: 15721, auto_failover_enabled: 0 }, ...extra });
// Card readings carry keys; the report must never show them.
const cards = (problems = {}) => async () => new Map(['company', 'doro'].map(id => [id,
  { fingerprint: fingerprints[id], problem: problems[id] ?? null, connection: problems[id] ? null : { key: `sk-${id}-secret-should-not-leak` } }]));
const client = (account = { type: 'chatgpt', email: 'private@example.invalid' }) => async () => ({
  request: async method => { assert.equal(method, 'account/read'); return { account }; }, close: async () => {} });
const missing = code => async () => { throw Object.assign(new Error('no configuration'), { code }); };
const healthy = {
  nodeVersion: '24.11.1', runtimeProblem: () => null, sqlite: async () => null, openClient: client(), trustCheck: async () => {},
  inspect: async () => layout(), loadConfig: async () => config, gatewayStatus: async () => ({ running: true, readiness: 'ready' }),
  integration: async () => ({ phase: 'installed', readyForNewThreads: true }), readCards: cards(),
};
const status = result => Object.fromEntries(result.checks.map(check => [check.id, check.status]));
const by = (result, id) => result.checks.find(check => check.id === id);

test('a complete setup is ready, names where new conversations start and lists the usable cards', async () => {
  const result = await checkEnvironment('/data', {}, healthy);
  assert.equal(result.ready, true); assert.equal(result.next, null);
  assert.deepEqual(status(result), { node: 'ok', sqlite3: 'ok', codex: 'ok', login: 'ok', hooks: 'ok', ccswitch: 'ok', ccswitch_proxy: 'ok',
    default_card: 'ok', configuration: 'ok', gateway: 'ok', connection: 'ok', routes: 'ok' });
  assert.match(by(result, 'default_card').summary, /default card "API2 copy" \(connects directly\)/);
  assert.match(by(result, 'configuration').summary, /recommended backup: OpenAI Official/);
  assert.match(by(result, 'routes').summary, /^Usable cards: OpenAI Official, API2 copy, Doro; unavailable: Work ChatGPT \(managed_official_account\)$/);
  assert.ok(!JSON.stringify(result).includes('should-not-leak'));
  assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
});

test('a new user sees the setup steps still to do, first one first', async () => {
  const result = await checkEnvironment('/data', {}, { ...healthy, loadConfig: missing('NOT_CONFIGURED'),
    trustCheck: async () => { throw new Error('untrusted'); }, integration: async () => assert.fail('no configuration yet') });
  assert.equal(result.ready, false);
  assert.deepEqual(status(result), { node: 'ok', sqlite3: 'ok', codex: 'ok', login: 'ok', hooks: 'todo', ccswitch: 'ok', ccswitch_proxy: 'ok',
    default_card: 'ok', configuration: 'todo', gateway: 'skip', connection: 'skip', routes: 'ok' });
  assert.match(result.next, /\/hooks/);
  assert.match(by(result, 'configuration').fix, /接入 ModelTrace/);
});

test('missing tools and an unreadable CCSwitch each say how to fix them, and dependent items are skipped', async () => {
  const result = await checkEnvironment('/data', {}, { ...healthy, runtimeProblem: () => 'old node', sqlite: async () => 'sqlite3 is not installed or not on PATH',
    openClient: async () => { throw new Error('ENOENT codex'); }, inspect: async () => { throw new Error('no db'); }, loadConfig: missing('NOT_CONFIGURED') });
  assert.deepEqual(status(result), { node: 'fail', sqlite3: 'fail', codex: 'fail', login: 'skip', hooks: 'skip', ccswitch: 'fail', ccswitch_proxy: 'skip',
    default_card: 'skip', configuration: 'todo', gateway: 'skip', connection: 'skip' });
  for (const id of ['node', 'sqlite3', 'codex', 'ccswitch']) assert.ok(by(result, id).fix, id);
  assert.match(result.next, /Node\.js/);
});

test('CCSwitch drift, a stale gateway and a rewritten Codex config are reported with their repair', async () => {
  const result = await checkEnvironment('/data', {}, { ...healthy, openClient: client({ type: 'apiKey' }),
    inspect: async () => layout({ mode: 'direct', defaultProvider: 'doro', listener: { listen_port: 15721, auto_failover_enabled: 1 } }),
    gatewayStatus: async () => ({ running: true, readiness: 'upgrade_required' }), integration: async () => ({ phase: 'conflict', readyForNewThreads: false }) });
  assert.equal(by(result, 'login').status, 'ok'); assert.match(by(result, 'login').summary, /OpenAI Official needs a ChatGPT login/);
  assert.doesNotMatch(by(result, 'routes').summary, /Usable cards: [^;]*OpenAI Official/, 'Official is not usable without a ChatGPT login');
  assert.match(by(result, 'routes').summary, /OpenAI Official \(official_needs_chatgpt_login\)/);
  assert.equal(by(result, 'ccswitch_proxy').status, 'fail'); assert.match(by(result, 'ccswitch_proxy').fix, /Routing or Aggregation/);
  assert.equal(by(result, 'default_card').status, 'skip'); assert.equal(by(result, 'failover'), undefined);
  assert.equal(by(result, 'gateway').status, 'fail'); assert.match(by(result, 'gateway').fix, /gateway-stop, then gateway-start/);
  assert.equal(by(result, 'connection').status, 'fail'); assert.match(by(result, 'connection').fix, /重新接入/);
});

test('a default card new conversations cannot use is a failure with its fix; failover matters only through CCSwitch', async () => {
  const check = async (extra, options = {}) => checkEnvironment('/data', {}, { ...healthy, inspect: async () => layout(extra), ...options });
  // Reachable only through CCSwitch: its automatic failover must be off.
  const relayed = await check({ listener: { listen_address: '127.0.0.1', listen_port: 15721, auto_failover_enabled: 1 } },
    { readCards: cards({ company: 'needs_ccswitch_conversion' }) });
  assert.equal(by(relayed, 'default_card').status, 'ok'); assert.match(by(relayed, 'default_card').summary, /through CCSwitch/);
  assert.equal(by(relayed, 'failover').status, 'fail'); assert.equal(relayed.ready, false);
  const direct = await check({ listener: { listen_address: '127.0.0.1', listen_port: 15721, auto_failover_enabled: 1 } });
  assert.equal(by(direct, 'failover'), undefined, 'a directly connected default card does not depend on CCSwitch failover');
  const managed = await check({ defaultProvider: 'work' });
  assert.equal(by(managed, 'default_card').status, 'fail'); assert.match(by(managed, 'default_card').summary, /managed_official_account/);
  assert.match(by(managed, 'default_card').fix, /select another default Codex card in CC Switch/);
  const personal = await check({ defaultProvider: 'official' }, { openClient: client({ type: 'apiKey' }) });
  assert.equal(by(personal, 'default_card').status, 'fail'); assert.match(by(personal, 'default_card').fix, /codex login/);
  assert.equal(by(await check({ defaultProvider: 'official' }), 'default_card').status, 'ok');
  const none = await check({ defaultProvider: null });
  assert.equal(by(none, 'default_card').status, 'fail'); assert.match(by(none, 'default_card').fix, /Select a default Codex card/);
});

test('a configuration from before 0.5 asks to reconnect; an invalid one says how to start over', async () => {
  const inspected = [];
  const outdated = await checkEnvironment('/data', {}, { ...healthy, loadConfig: missing('CONFIG_OUTDATED'),
    readRawConfig: async () => ({ schema: 2, ccSwitchDirectory: '/legacy/cc-switch' }), inspect: async directory => { inspected.push(directory); return layout(); } });
  assert.equal(by(outdated, 'configuration').status, 'todo'); assert.match(by(outdated, 'configuration').fix, /重新接入 ModelTrace/);
  assert.equal(by(outdated, 'gateway').status, 'skip'); assert.equal(outdated.ready, false);
  assert.deepEqual(inspected, [path.resolve('/legacy/cc-switch')], 'the outdated configuration still names the CCSwitch data in use');
  const invalid = await checkEnvironment('/data', {}, { ...healthy, loadConfig: missing(undefined) });
  assert.equal(by(invalid, 'configuration').status, 'fail'); assert.match(by(invalid, 'configuration').fix, /gateway-config\.json/);
});

test('one usable card leaves nothing to switch to', async () => {
  const result = await checkEnvironment('/data', {}, { ...healthy, openClient: client({ type: 'apiKey' }), readCards: cards({ doro: 'key_missing' }) });
  assert.equal(by(result, 'routes').status, 'todo'); assert.match(by(result, 'routes').summary, /^Usable cards: API2 copy;/);
  assert.equal(result.ready, false);
});

test('without any Codex login the check says how to sign in, including the API-key option', async () => {
  const result = await checkEnvironment('/data', {}, { ...healthy, openClient: client(null) });
  const login = by(result, 'login');
  assert.equal(login.status, 'fail'); assert.match(login.fix, /codex login --with-api-key/);
  assert.equal(result.ready, false);
});
