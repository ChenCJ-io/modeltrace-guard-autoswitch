import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  assertProviderCurrent, atomicJSON, configPath, configureGateway, defaultCardId, describeProvider,
  inspectCCSwitch, loadGatewayConfig, resolveProvider, routeDescriptor, sameProvider, verifyGatewayReady, verifyGatewayRoute, verifyRouteLayout,
} from '../scripts/provider-config.mjs';
import { readDirectCards } from '../scripts/direct-route.mjs';

const execute = promisify(execFile);
const sqlValue = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const syntheticKey = 'synthetic-api-key-never-exported';
const syntheticLogin = 'synthetic-login-never-exported';
const syntheticAccount = 'synthetic-bound-account-never-exported';
const plainOfficial = { auth: {}, config: '' };
const nativeMeta = { providerType: 'codex_oauth' };
// A key-based card the gateway can connect to directly.
const relayCard = { auth: {}, config: 'model_provider = "relay"\n[model_providers.relay]\nbase_url = "https://relay.example.invalid/v1"\nwire_api = "responses"\nexperimental_bearer_token = "synthetic-relay-token"\n' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'provider-config-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('provider-config-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const db = path.join(directory, 'cc-switch.db');
  const sql = statement => execute('sqlite3', [db, statement]);
  await sql(`CREATE TABLE providers(id TEXT,name TEXT,category TEXT,app_type TEXT,settings_config TEXT,meta TEXT);
    CREATE TABLE proxy_config(app_type TEXT,listen_address TEXT,listen_port INTEGER,auto_failover_enabled INTEGER);
    INSERT INTO proxy_config VALUES('codex','127.0.0.1',15721,0);`);
  async function put({ id, name, category = null, config = plainOfficial, meta = null, rawConfig, rawMeta }) {
    await sql(`DELETE FROM providers WHERE id=${sqlValue(id)};
      INSERT INTO providers VALUES(${[id, name, category, 'codex', rawConfig ?? JSON.stringify(config),
        rawMeta ?? (meta == null ? null : JSON.stringify(meta))].map(sqlValue).join(',')});`);
  }
  await put({ id: 'company', name: 'API2copy', config: { auth: { OPENAI_API_KEY: syntheticKey }, config: '' } });
  await put({ id: 'official', name: 'OpenAI Official', category: 'official', meta: nativeMeta });
  await put({ id: 'other', name: 'Other Relay', config: { auth: { OPENAI_API_KEY: 'synthetic-other-key' }, config: '' } });
  const live = { apps: { codex: { mode: 'proxy', attached: true, proxy_route: 'company',
    stack: { enabled: true, members: ['company', 'other'], keys: { company: 'company', other: 'other' } },
  } } };
  const saveLive = () => atomicJSON(path.join(directory, 'live-state.json'), live);
  await saveLive();
  return { directory, db, sql, put, live, saveLive, inspect: () => inspectCCSwitch(directory) };
}

test('inspection returns only identity metadata and flags, leaves storage unchanged, and accepts the unbound codex_oauth preset', async t => {
  const f = await fixture(t);
  await f.put({ id: 'snapshot', name: 'Stored login', category: 'official',
    config: { auth: { tokens: { access_token: syntheticLogin } }, config: '' },
    meta: { ...nativeMeta, authBinding: { source: 'managed_account', authProvider: 'codex_oauth', accountId: syntheticAccount } },
  });
  const beforeDB = await readFile(f.db), beforeLive = await readFile(path.join(f.directory, 'live-state.json'));
  const layout = await f.inspect();
  for (const row of layout.providers) {
    assert.deepEqual(Object.keys(row), ['id', 'name', 'category', 'fingerprint', 'nativeOfficial', 'followsNativeLogin', 'managedCodexAccount', 'delegatedAuth']);
    assert.match(row.fingerprint, /^[a-f0-9]{64}$/i);
  }
  const output = JSON.stringify(layout);
  for (const secret of [syntheticKey, syntheticLogin, syntheticAccount]) assert.equal(output.includes(secret), false);
  assert.deepEqual(await readFile(f.db), beforeDB);
  assert.deepEqual(await readFile(path.join(f.directory, 'live-state.json')), beforeLive);
  const official = layout.providers.find(row => row.id === 'official');
  assert.equal(official.nativeOfficial, 1);
  assert.equal(official.followsNativeLogin, 1);
  assert.equal(describeProvider(layout, 'official').transport, 'official');
  assert.equal(layout.providers.find(row => row.id === 'snapshot').nativeOfficial, 0);
  assert.equal(layout.providers.find(row => row.id === 'snapshot').followsNativeLogin, 0);
});

test('provider names use exact matches first, then one case-insensitive match, never a prefix or an arbitrary ambiguous result', async t => {
  const f = await fixture(t);
  let layout = await f.inspect();
  assert.equal(resolveProvider(layout, { name: ' API2copy ' }).id, 'company');
  assert.equal(resolveProvider(layout, { name: 'api2COPY' }).id, 'company');
  assert.equal(resolveProvider(layout, { id: 'company' }).name, 'API2copy');
  assert.throws(() => resolveProvider(layout, { name: 'API2' }), { code: 'PROVIDER_NOT_FOUND' });
  assert.throws(() => resolveProvider(layout, { name: 'API2copy', id: 'company' }), /exactly one/);
  assert.throws(() => resolveProvider(layout, { name: '  ' }), /nonempty string/);
  assert.throws(() => resolveProvider(layout, { name: 42 }), /nonempty string/);
  await f.put({ id: 'same-spelling', name: 'API2copy' });
  layout = await f.inspect();
  assert.throws(() => resolveProvider(layout, { name: 'API2copy' }), error => {
    assert.equal(error.code, 'AMBIGUOUS_PROVIDER');
    assert.deepEqual(error.candidates.map(row => row.id).sort(), ['company', 'same-spelling']);
    assert.ok(error.candidates.every(row => Object.keys(row).join(',') === 'id,name'));
    return true;
  });
  await f.put({ id: 'same-spelling', name: 'api2copy' });
  layout = await f.inspect();
  assert.equal(resolveProvider(layout, { name: 'API2copy' }).id, 'company', 'exact spelling remains an explicit selection');
  assert.throws(() => resolveProvider(layout, { name: 'API2COPY' }), { code: 'AMBIGUOUS_PROVIDER' });
});

test('the configuration records only an optional recommended backup, keeps its capability token and never a key', async t => {
  const f = await fixture(t), before = await readFile(path.join(f.directory, 'live-state.json'), 'utf8');
  await f.put({ id: 'other', name: 'Other Relay', config: relayCard });
  const configured = await configureGateway(f.directory, { backupName: 'OpenAI Official', ccSwitchDirectory: f.directory });
  assert.equal(configured.schema, 3); assert.equal(Object.hasOwn(configured, 'token'), false);
  assert.equal(Object.hasOwn(configured, 'primary'), false, 'new conversations start on CCSwitch\'s default card instead');
  assert.deepEqual([configured.backup.id, configured.backup.transport, configured.backup.key], ['official', 'official', null]);
  const saved = await loadGatewayConfig(f.directory);
  assert.match(saved.token, /^[a-f0-9]{64}$/);
  // A key-based backup is reached directly; CCSwitch's default card is never one.
  const relay = await configureGateway(f.directory, { backupName: 'Other Relay', ccSwitchDirectory: f.directory });
  assert.deepEqual([relay.backup.transport, relay.backup.key], ['direct', null]);
  const again = await loadGatewayConfig(f.directory);
  assert.equal(again.token, saved.token, 'Codex keeps the same entry URL');
  assert.equal(again.id, saved.id, 'changing only the recommended backup keeps routes and conversations'); assert.equal(relay.configurationKept, true);
  await assert.rejects(configureGateway(f.directory, { port: 15999, requireSameId: true }), /Stop this gateway/);
  assert.equal((await loadGatewayConfig(f.directory)).port, saved.port, 'refused before anything is written');
  const moved = await configureGateway(f.directory, { backupName: 'Other Relay', port: 15999 });
  assert.equal(moved.configurationKept, false); assert.notEqual((await loadGatewayConfig(f.directory)).id, saved.id);
  await assert.rejects(configureGateway(f.directory, { backupName: 'API2copy', ccSwitchDirectory: f.directory }), /Recommend a card/);
  const none = await configureGateway(f.directory, { ccSwitchDirectory: f.directory });
  assert.equal(none.backup, null);
  assert.ok(!(await readFile(configPath(f.directory), 'utf8')).includes('synthetic-relay-token'), 'the configuration never stores a card key');
  assert.equal(await readFile(path.join(f.directory, 'live-state.json'), 'utf8'), before);
  // Without any CCSwitch listener the configuration has no CCSwitch upstream.
  await f.sql('DELETE FROM proxy_config');
  assert.equal((await configureGateway(f.directory, { ccSwitchDirectory: f.directory })).upstream, null);
});

test('new conversations start on CCSwitch\'s default card, which needs CCSwitch\'s proxy', async t => {
  const f = await fixture(t), layout = await f.inspect();
  assert.equal(defaultCardId(layout), 'company');
  assert.throws(() => defaultCardId({ ...layout, mode: 'direct' }), { code: 'CCSWITCH_NOT_PROXIED' });
  assert.throws(() => defaultCardId({ ...layout, attached: false }), { code: 'CCSWITCH_NOT_PROXIED' });
  assert.throws(() => defaultCardId({ ...layout, pending: true }), { code: 'CCSWITCH_NOT_PROXIED' });
  assert.throws(() => defaultCardId({ ...layout, defaultProvider: null }), { code: 'NO_DEFAULT_CARD' });
  assert.throws(() => defaultCardId({ ...layout, defaultProvider: 'deleted' }), { code: 'NO_DEFAULT_CARD' });
});

test('a card takes the direct route when its saved configuration allows it, otherwise only CCSwitch\'s routes', async t => {
  const f = await fixture(t);
  await f.put({ id: 'other', name: 'Other Relay', config: relayCard });
  await f.put({ id: 'copilot', name: 'Copilot', meta: { providerType: 'github_copilot' } });
  const layout = await f.inspect(), cards = await readDirectCards(f.directory);
  assert.deepEqual(routeDescriptor(layout, 'other', cards.get('other')), describeProvider(layout, 'other'));
  assert.equal(routeDescriptor(layout, 'other', cards.get('other')).transport, 'direct');
  // No usable direct configuration: only as CCSwitch's default card.
  const company = routeDescriptor(layout, 'company', cards.get('company'));
  assert.deepEqual([company.transport, company.key], ['ccswitch', null]);
  assert.throws(() => routeDescriptor({ ...layout, defaultProvider: 'other' }, 'company', cards.get('company')),
    error => error.code === 'DIRECT_UNUSABLE' && error.problem === 'card_provider_missing');
  assert.throws(() => routeDescriptor({ ...layout, defaultProvider: 'other' }, 'company', undefined), error => error.problem === 'card_config_unreadable');
  assert.throws(() => routeDescriptor({ ...layout, defaultProvider: 'company' }, 'other', { ...cards.get('other'), fingerprint: 'e'.repeat(64) }),
    error => error.problem === 'card_changed', 'a reading of another card version never counts');
  // A login CCSwitch manages: its default card, or an Aggregation member.
  assert.throws(() => routeDescriptor(layout, 'copilot'), { code: 'NOT_IN_STACK' });
  assert.deepEqual(routeDescriptor({ ...layout, defaultProvider: 'copilot' }, 'copilot').key, null);
  const stacked = { ...layout, stack: { enabled: true, members: ['copilot'], keys: { copilot: 'copilot' } } };
  assert.deepEqual([routeDescriptor(stacked, 'copilot').transport, routeDescriptor(stacked, 'copilot').key], ['ccswitch', 'copilot']);
  assert.equal(routeDescriptor(layout, 'official').transport, 'official');
});

test('CCSwitch\'s default route fails closed on default drift and enabled or unknown failover; other routes do not depend on it', async t => {
  const f = await fixture(t);
  await configureGateway(f.directory, { backupName: 'OpenAI Official', ccSwitchDirectory: f.directory });
  const config = await loadGatewayConfig(f.directory), layout = await f.inspect();
  const route = { transport: 'ccswitch', route: 'source', ccswitchMode: 'default', providerId: 'company', sourceKey: null };
  await verifyGatewayRoute(f.directory, config, route);
  assert.equal(verifyRouteLayout(config, layout, { ...route, route: 'fallback' }), true, 'a conversation may switch to CCSwitch\'s default card');
  for (const [variant, expected] of [
    [{ ...layout, defaultProvider: 'other' }, /default card changed/],
    [{ ...layout, listener: { ...layout.listener, auto_failover_enabled: 1 } }, /automatic failover/],
    [{ ...layout, listener: { listen_address: '127.0.0.1', listen_port: 15721 } }, /automatic failover/],
    [{ ...layout, mode: 'direct' }, /local proxy/],
    [{ ...layout, listener: { ...layout.listener, listen_port: 15999 } }, /listener/],
  ]) {
    assert.throws(() => verifyRouteLayout(config, variant, route), expected);
    assert.equal(verifyRouteLayout(config, variant, { transport: 'official', providerId: 'official', route: 'fallback' }), true);
    assert.equal(verifyRouteLayout(config, variant, { transport: 'direct', providerId: 'other', route: 'fallback' }), true);
  }
  assert.throws(() => verifyRouteLayout(config, layout, { ...route, ccswitchMode: 'stack' }), /route mode/);
  assert.equal(verifyRouteLayout(config, layout, { transport: 'ccswitch', route: 'fallback', ccswitchMode: 'stack', providerId: 'other', sourceKey: 'other' }), true);
  assert.throws(() => verifyRouteLayout(config, { ...layout, stack: { enabled: false, members: [], keys: {} } },
    { transport: 'ccswitch', route: 'fallback', ccswitchMode: 'stack', providerId: 'other', sourceKey: 'other' }), { code: 'NOT_IN_STACK' });
});

test('Official account bindings and every extra auth field are rejected even if a stale Stack membership remains', async t => {
  const f = await fixture(t);
  f.live.apps.codex.stack.members.push('official');
  f.live.apps.codex.stack.keys.official = 'official';
  await f.saveLive();
  const variants = [
    { meta: { ...nativeMeta, authBinding: { source: 'managed_account', authProvider: 'codex_oauth', accountId: syntheticAccount } } },
    { meta: { ...nativeMeta, authBinding: { source: 'managed_account', authProvider: 'codex_oauth' } } },
    { meta: { ...nativeMeta, authBinding: { source: 'provider_config', accountId: syntheticAccount } } },
    { meta: { ...nativeMeta, githubAccountId: syntheticAccount } },
    { meta: { providerType: 'github_copilot' } },
    { meta: { providerType: 'xai_oauth' } },
    ...['tokens', 'access_token', 'refresh_token', 'id_token', 'future_login_snapshot', 'OPENAI_API_KEY'].map(key => ({
      config: { auth: { [key]: syntheticLogin }, config: '' },
    })),
    { config: { auth: { tokens: null }, config: '' } },
    { config: { auth: { OPENAI_API_KEY: null }, config: '' } },
  ];
  for (const variant of variants) {
    await f.put({ id: 'official', name: 'OpenAI Official', category: 'official', config: plainOfficial, meta: nativeMeta, ...variant });
    const layout = await f.inspect(), row = layout.providers.find(p => p.id === 'official');
    assert.equal(row.nativeOfficial, 0);
    assert.equal(row.followsNativeLogin, 0);
    assert.throws(() => describeProvider(layout, 'official'), /Official card/);
    assert.equal(JSON.stringify(layout).includes(syntheticLogin), false);
    assert.equal(JSON.stringify(layout).includes(syntheticAccount), false);
  }
});

test('invalid metadata cannot be normalized into an unbound native login and connection overrides remain unsupported', async t => {
  const f = await fixture(t);
  const variants = [
    { rawMeta: '{invalid-json' }, { rawMeta: 'null' }, { meta: [] },
    { meta: { providerType: 0 } }, { meta: { authBinding: 'managed_account' } },
    { meta: { authBinding: [] } }, { meta: { authBinding: { source: null } } },
    { meta: { authBinding: { source: 'unknown' } } },
    { meta: { authBinding: { source: 'provider_config', accountId: {} } } },
    { meta: { authBinding: { source: 'provider_config', authProvider: 'github_copilot' } } },
    { meta: { githubAccountId: {} } }, { rawConfig: '{invalid-json' }, { config: { auth: [] } },
  ];
  for (const variant of variants) {
    await f.put({ id: 'official', name: 'OpenAI Official', category: 'official', meta: nativeMeta, ...variant });
    const layout = await f.inspect(), row = layout.providers.find(p => p.id === 'official');
    assert.equal(row.nativeOfficial, 0);
    assert.equal(row.followsNativeLogin, 0);
    assert.throws(() => describeProvider(layout, 'official'), /Official card/);
  }
  for (const override of [{ config: 'model_provider="custom"' }, { base_url: 'https://fixture.invalid' },
    { baseUrl: 'https://fixture.invalid' }, { baseURL: 'https://fixture.invalid' }]) {
    await f.put({ id: 'official', name: 'OpenAI Official', category: 'official', meta: nativeMeta, config: { ...plainOfficial, ...override } });
    const layout = await f.inspect();
    assert.equal(layout.providers.find(p => p.id === 'official').nativeOfficial, 0);
    assert.throws(() => describeProvider(layout, 'official'), /Official card/);
  }
});

test('legacy managed Codex cards without an Official category cannot bypass account checks through Stack', async t => {
  const f = await fixture(t);
  for (const accountId of [syntheticAccount, '', null, undefined]) {
    await f.put({ id: 'other', name: 'Legacy Codex Account', meta: { ...nativeMeta,
      authBinding: { source: 'managed_account', authProvider: 'codex_oauth', accountId },
    } });
    const layout = await f.inspect(), row = layout.providers.find(p => p.id === 'other');
    assert.equal(row.category, null);
    assert.equal(row.managedCodexAccount, 1);
    assert.equal(row.nativeOfficial, 0);
    assert.equal(row.followsNativeLogin, 0);
    assert.throws(() => describeProvider(layout, 'other'), /managed Codex account/);
    assert.equal(JSON.stringify(layout).includes(syntheticAccount), false);
  }
});

test('other OAuth Stack cards stay delegated to CCSwitch with their binding included in drift evidence', async t => {
  const f = await fixture(t);
  for (const providerType of ['github_copilot', 'xai_oauth']) {
    await f.put({ id: 'other', name: 'Other Relay', meta: { providerType,
      authBinding: { source: 'managed_account', authProvider: providerType, accountId: syntheticAccount },
    } });
    const before = await f.inspect(), descriptor = describeProvider(before, 'other');
    assert.equal(descriptor.transport, 'ccswitch');
    assert.equal(descriptor.key, 'other');
    assert.equal(before.providers.find(row => row.id === 'other').followsNativeLogin, 0);
    assert.equal(JSON.stringify(before).includes(syntheticAccount), false);
    await f.put({ id: 'other', name: 'Other Relay', meta: { providerType,
      authBinding: { source: 'managed_account', authProvider: providerType },
    } });
    const changed = await f.inspect();
    assert.equal(describeProvider(changed, 'other').transport, 'ccswitch', 'CCSwitch retains ownership of default-account resolution');
    assert.throws(() => assertProviderCurrent(changed, descriptor), /fresh consent/);
  }
});

test('provider names and saved connection changes invalidate descriptors without disclosing the changed values', async t => {
  const f = await fixture(t), original = describeProvider(await f.inspect(), 'company');
  await f.put({ id: 'company', name: 'Renamed Company', config: { auth: { OPENAI_API_KEY: syntheticKey }, config: '' } });
  const renamed = await f.inspect();
  assert.equal(sameProvider(describeProvider(renamed, 'company'), original), false);
  assert.throws(() => assertProviderCurrent(renamed, original), /fresh consent/);
  const beforeRotation = describeProvider(renamed, 'company');
  await f.put({ id: 'company', name: 'Renamed Company', config: { auth: { OPENAI_API_KEY: syntheticLogin }, config: '' } });
  const rotated = await f.inspect();
  assert.throws(() => assertProviderCurrent(rotated, beforeRotation), /fresh consent/);
  assert.equal(JSON.stringify(rotated).includes(syntheticLogin), false);
});

test('configurations from before 0.5 are reported as outdated without rewriting them', async t => {
  const f = await fixture(t);
  for (const legacy of [{ schema: 1, sourceProvider: 'company', fallbackProvider: 'official', token: syntheticLogin },
    { schema: 2, id: '11111111-1111-4111-8111-111111111111', primary: { id: 'company' }, backup: null, token: 'a'.repeat(64), port: 15722 }]) {
    await atomicJSON(configPath(f.directory), legacy);
    const before = await readFile(configPath(f.directory), 'utf8');
    await assert.rejects(loadGatewayConfig(f.directory), error => error.code === 'CONFIG_OUTDATED' && /predates 0\.5/.test(error.message));
    assert.equal(await readFile(configPath(f.directory), 'utf8'), before);
  }
  await rm(configPath(f.directory));
  await assert.rejects(loadGatewayConfig(f.directory), { code: 'NOT_CONFIGURED' });
});

test('inspection waits out CCSwitch\'s brief commit lock instead of failing the request', async t => {
  const f = await fixture(t);
  const writer = spawn('sqlite3', [f.db], { stdio: ['pipe', 'ignore', 'ignore'] }), exited = once(writer, 'exit');
  writer.stdin.write("BEGIN EXCLUSIVE; INSERT INTO proxy_config VALUES('other','127.0.0.1',1,0);\n");
  await delay(200);
  const started = Date.now(), inspected = f.inspect();
  await delay(600);
  writer.stdin.end('COMMIT;\n');
  const layout = await inspected;
  assert.ok(Date.now() - started >= 500, 'the read waited for the lock');
  assert.ok(layout.providers.some(row => row.id === 'company'));
  await exited;
});

test('a saved route only matches the same unchanged card of a kind that can take it', () => {
  const fingerprint = 'a'.repeat(64);
  const layout = { defaultProvider: 'company', stack: { enabled: false, members: [], keys: {} },
    providers: [{ id: 'company', name: 'Company', category: null, fingerprint: 'b'.repeat(64), nativeOfficial: 0, followsNativeLogin: 0, managedCodexAccount: 0, delegatedAuth: 0 },
      { id: 'relay', name: 'Relay', category: null, fingerprint, nativeOfficial: 0, followsNativeLogin: 0, managedCodexAccount: 0, delegatedAuth: 0 }] };
  const direct = { id: 'relay', name: 'Relay', fingerprint, transport: 'direct', key: null };
  assertProviderCurrent(layout, direct);
  // CCSwitch's default route (no selector) can carry any relay card.
  assertProviderCurrent(layout, { ...direct, transport: 'ccswitch' });
  assert.throws(() => assertProviderCurrent(layout, { ...direct, fingerprint: 'c'.repeat(64) }), /fresh consent/, 'an edited card needs a new choice');
  assert.throws(() => assertProviderCurrent(layout, { ...direct, name: 'Renamed' }), /fresh consent/);
  assert.throws(() => assertProviderCurrent(layout, { ...direct, transport: 'official' }), /fresh consent/);
  assert.throws(() => assertProviderCurrent(layout, { ...direct, transport: 'ccswitch', key: 'relay' }), /fresh consent/, 'an Aggregation route needs a card whose login CCSwitch manages');
});
