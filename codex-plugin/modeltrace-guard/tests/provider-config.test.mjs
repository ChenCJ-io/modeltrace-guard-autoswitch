import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  assertProviderCurrent, atomicJSON, configPath, configureGateway, describeProvider,
  inspectCCSwitch, loadGatewayConfig, resolveProvider, sameProvider, verifyGatewayReady, verifyGatewayRoute, verifyLayout,
} from '../scripts/provider-config.mjs';

const execute = promisify(execFile);
const sqlValue = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const syntheticKey = 'synthetic-api-key-never-exported';
const syntheticLogin = 'synthetic-login-never-exported';
const syntheticAccount = 'synthetic-bound-account-never-exported';
const plainOfficial = { auth: {}, config: '' };
const nativeMeta = { providerType: 'codex_oauth' };

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
    assert.deepEqual(Object.keys(row), ['id', 'name', 'category', 'fingerprint', 'nativeOfficial', 'followsNativeLogin', 'managedCodexAccount']);
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

test('schema 2 config preserves the company default and exposes stable primary and backup descriptors without a token', async t => {
  const f = await fixture(t), before = await readFile(path.join(f.directory, 'live-state.json'), 'utf8');
  const configured = await configureGateway(f.directory, {
    primaryName: 'API2copy', backupName: 'OpenAI Official', ccSwitchDirectory: f.directory,
  });
  assert.equal(configured.schema, 2);
  assert.equal(Object.hasOwn(configured, 'token'), false);
  assert.equal(configured.primary.id, 'company');
  assert.equal(configured.primary.transport, 'ccswitch');
  assert.equal(configured.primary.key, 'company');
  assert.equal(configured.backup.id, 'official');
  assert.equal(configured.backup.transport, 'official');
  assert.equal(configured.backup.key, null);
  const saved = await loadGatewayConfig(f.directory), layout = await verifyGatewayReady(f.directory, saved);
  assert.match(saved.token, /^[a-f0-9]{64}$/);
  assert.equal(layout.defaultProvider, 'company');
  assert.equal(verifyLayout(saved, { ...layout, defaultProvider: 'other' }), true, 'base validation does not reroute an already selected Official session');
  await verifyGatewayRoute(f.directory, saved);
  assert.equal(await readFile(path.join(f.directory, 'live-state.json'), 'utf8'), before);
  const thirdPartyBackup = await configureGateway(f.directory, {
    primaryName: 'API2copy', backupName: 'Other Relay', ccSwitchDirectory: f.directory,
  });
  assert.equal(thirdPartyBackup.backup.transport, 'ccswitch');
  assert.equal(thirdPartyBackup.backup.key, 'other');
});

test('primary readiness fails closed on default drift, enabled or unknown failover, without changing configuration', async t => {
  const f = await fixture(t);
  await configureGateway(f.directory, { primaryName: 'API2copy', backupName: 'OpenAI Official', ccSwitchDirectory: f.directory });
  const config = await loadGatewayConfig(f.directory), before = await readFile(configPath(f.directory));
  const layout = await f.inspect();
  for (const variant of [
    { ...layout, defaultProvider: 'other' },
    { ...layout, listener: { ...layout.listener, auto_failover_enabled: 1 } },
    { ...layout, listener: { listen_address: '127.0.0.1', listen_port: 15721 } },
  ]) {
    await assert.rejects(verifyGatewayRoute(f.directory, config, undefined, async () => variant), /default provider changed|automatic failover/);
    await assert.rejects(configureGateway(f.directory, { primaryName: 'API2copy', backupName: 'OpenAI Official', ccSwitchDirectory: f.directory }, async () => variant), /default provider changed|automatic failover/);
    assert.deepEqual(await readFile(configPath(f.directory)), before);
    await verifyGatewayRoute(f.directory, config, { transport: 'official', providerId: 'official', route: 'fallback' }, async () => variant);
  }
  const route = { transport: 'ccswitch', route: 'source', ccswitchMode: 'default', providerId: config.primary.id,
    providerFingerprint: config.primary.fingerprint, sourceKey: config.primary.key };
  await verifyGatewayRoute(f.directory, config, route);
  await assert.rejects(verifyGatewayRoute(f.directory, config, { ...route, ccswitchMode: 'stack' }), /route mode/);
  await assert.rejects(verifyGatewayRoute(f.directory, config, { ...route, providerFingerprint: 'changed' }), /identity changed/);
  await assert.rejects(verifyGatewayRoute(f.directory, config, { ...route, providerId: 'other' }), /route mode/);
  await verifyGatewayRoute(f.directory, config, { transport: 'ccswitch', route: 'fallback', ccswitchMode: 'stack', providerId: 'other' });
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

test('schema 1 automatic-switch configuration is rejected without rewriting or silently migrating it', async t => {
  const f = await fixture(t);
  await atomicJSON(configPath(f.directory), { schema: 1, sourceProvider: 'company', fallbackProvider: 'official', token: syntheticLogin });
  const before = await readFile(configPath(f.directory), 'utf8');
  await assert.rejects(loadGatewayConfig(f.directory), /reconfigure.*per-incident approval/);
  assert.equal(await readFile(configPath(f.directory), 'utf8'), before);
});
