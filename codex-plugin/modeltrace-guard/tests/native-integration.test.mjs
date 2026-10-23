import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir, uptime } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { atomicJSON, configPath, gatewayURL } from '../scripts/provider-config.mjs';
import { classifyRoute, installNativeIntegration, nativeIntegrationStatus, removeNativeIntegration } from '../scripts/native-integration.mjs';

const KEYS = ['model_provider', 'openai_base_url'];
const clone = value => structuredClone(value);
const originalURL = 'https://original.invalid/private-original-value';

async function fixture(t, user = { model_provider: 'custom', openai_base_url: originalURL, model: 'fixture-model', model_providers: { custom: { untouched: true } } }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profileFile = path.join(directory, 'profile', 'config.toml');
  const env = { CODEX_HOME: path.dirname(profileFile) };
  const config = { schema: 2, id: randomUUID(), ccSwitchDirectory: path.join(directory, 'cc-switch'),
    primary: { id: 'company', name: 'Company', fingerprint: 'a'.repeat(64), transport: 'ccswitch', key: 'company' },
    backup: { id: 'official', name: 'Official', fingerprint: 'b'.repeat(64), transport: 'official', key: null },
    upstream: 'http://127.0.0.1:15721/v1', port: 15722, token: randomBytes(32).toString('hex') };
  await atomicJSON(configPath(directory), config);
  const model = { user: clone(user), version: 1, file: profileFile, calls: [], connections: [], closes: 0,
    writes: [], writeStatus: 'ok', override: null, transformRead: value => value,
    beforeWrite: async () => {}, afterWrite: async () => {}, nullDeletes: true };
  const version = () => `version-${model.version}`;
  const userName = () => ({ type: 'user', file: model.file, profile: null });
  const connect = async (...args) => {
    model.connections.push(args);
    return {
      request: async (method, params) => {
        model.calls.push({ method, params: clone(params) });
        if (method === 'config/read') {
          assert.deepEqual(params, { includeLayers: true });
          const origins = Object.fromEntries(KEYS.filter(key => Object.hasOwn(model.user, key)).map(key => [key, { name: userName(), version: version() }]));
          const layers = [{ name: { type: 'user', file: path.join(directory, 'profiles', 'work.toml'), profile: 'work' },
            version: 'profile-version', config: { unrelated: true }, disabledReason: null },
          { name: userName(), version: version(), config: clone(model.user), disabledReason: null }];
          if (model.override) {
            const name = { type: 'project', dotCodexFolder: path.join(directory, 'project', '.codex') };
            layers.push({ name, version: 'project-version', config: clone(model.override), disabledReason: null });
            for (const key of Object.keys(model.override)) origins[key] = { name, version: 'project-version' };
          }
          return model.transformRead({ config: { model_provider: 'openai', ...clone(model.user), ...clone(model.override || {}) }, origins, layers });
        }
        assert.equal(method, 'config/batchWrite', 'The module must not call account, thread, trust or inference APIs');
        model.writes.push(clone(params));
        await model.beforeWrite(params);
        if (params.expectedVersion !== version()) throw new Error(`Native CAS conflict must not expose ${originalURL}`);
        assert.equal(params.filePath, model.file);
        assert.equal(params.reloadUserConfig, false);
        assert.deepEqual(params.edits.map(edit => edit.keyPath), KEYS);
        assert.ok(params.edits.every(edit => edit.mergeStrategy === 'replace'));
        for (const edit of params.edits) {
          if (edit.value === null && model.nullDeletes) delete model.user[edit.keyPath];
          else model.user[edit.keyPath] = edit.value;
        }
        model.version++;
        await model.afterWrite(params);
        return { status: model.writeStatus, version: version(), filePath: model.file,
          overriddenMetadata: model.writeStatus === 'okOverridden' ? { message: 'private native detail', effectiveValue: originalURL } : null };
      },
      close: async () => { model.closes++; },
    };
  };
  const dependencies = { connect };
  const filename = path.join(directory, 'native-integration.json');
  return { directory, profileFile, filename, env, config, model, connect,
    record: async () => JSON.parse(await readFile(filename, 'utf8')),
    install: options => installNativeIntegration(directory, env, { ...dependencies, ...options }),
    status: () => nativeIntegrationStatus(directory, env, dependencies),
    remove: () => removeNativeIntegration(directory, env, dependencies) };
}

function assertPublic(result, f) {
  const encoded = JSON.stringify(result);
  assert.ok(!encoded.includes(f.config.token));
  assert.ok(!encoded.includes(gatewayURL(f.config)));
  assert.ok(!encoded.includes(originalURL));
  assert.equal(result.monitoringStarted, false);
  assert.equal(result.currentThreadChanged, false);
  assert.equal(result.scope, 'future_new_threads');
}

test('status and removal without a record do not connect to native Codex', async t => {
  const f = await fixture(t);
  for (const result of [await f.status(), await f.remove()]) {
    assert.equal(result.phase, 'not_installed'); assert.equal(result.attached, false);
    assert.equal(result.readyForNewThreads, false); assertPublic(result, f);
  }
  assert.equal(f.model.connections.length, 0);
});

test('install writes exactly two base user keys with CAS and preserves every other setting privately', async t => {
  const f = await fixture(t), original = clone(f.model.user);
  const result = await f.install();
  assert.equal(result.attached, true); assert.equal(result.readyForNewThreads, true); assert.equal(result.phase, 'installed');
  assert.equal(result.profileFile, f.profileFile); assert.equal(result.configId, f.config.id);
  assert.deepEqual(f.model.user, { ...original, model_provider: 'openai', openai_base_url: gatewayURL(f.config) });
  assert.equal(f.model.writes[0].expectedVersion, 'version-1');
  assert.deepEqual(f.model.connections[0], [f.env], 'Do not add nativeOpenai session flags to config inspection');
  assert.equal(f.model.closes, 1);
  const record = await f.record();
  assert.deepEqual(record.original, { model_provider: { present: true, value: 'custom' }, openai_base_url: { present: true, value: originalURL } });
  assert.equal(record.owned.openai_base_url, gatewayURL(f.config)); assert.equal(record.pending, null);
  assert.equal(record.original.model_providers, undefined);
  if (process.platform !== 'win32') assert.equal((await stat(f.filename)).mode & 0o777, 0o600);
  assertPublic(result, f);
});

test('repeated install is idempotent and status never writes native configuration or its private record', async t => {
  const f = await fixture(t);
  await f.install();
  const first = await f.record();
  assert.equal((await f.install()).readyForNewThreads, true);
  assert.equal(f.model.writes.length, 1);
  assert.deepEqual((await f.record()).original, first.original);
  const before = await readFile(f.filename, 'utf8');
  assert.equal((await f.status()).readyForNewThreads, true);
  assert.equal(await readFile(f.filename, 'utf8'), before);
  assert.equal(f.model.writes.length, 1);
});

test('gateway updates require old owned values and retain the first originals through removal', async t => {
  const f = await fixture(t), original = clone(f.model.user);
  await f.install();
  const updated = { ...f.config, id: randomUUID(), token: randomBytes(32).toString('hex') };
  await atomicJSON(configPath(f.directory), updated);
  const stale = await f.status();
  assert.equal(stale.phase, 'stale_gateway_config'); assert.equal(stale.readyForNewThreads, false);
  const result = await f.install();
  assert.equal(result.configId, updated.id); assert.equal(result.readyForNewThreads, true);
  assert.equal(f.model.user.openai_base_url, gatewayURL(updated));
  assert.equal((await f.record()).original.openai_base_url.value, originalURL);
  f.model.user.unrelated = 'changed later'; f.model.version++;
  const removed = await f.remove();
  assert.equal(removed.phase, 'removed'); assert.equal(removed.attached, false);
  assert.equal(removed.readyForNewThreads, false);
  assert.deepEqual(f.model.user, { ...original, unrelated: 'changed later' });
  assertPublic(removed, f);
});

test('outside changes to either owned key block install and removal without overwriting them', async t => {
  const f = await fixture(t);
  await f.install();
  const saved = await readFile(f.filename, 'utf8');
  f.model.user.openai_base_url = 'https://another-user-choice.invalid'; f.model.version++;
  for (const action of [f.install, f.remove]) await assert.rejects(action(), error => error.code === 'NATIVE_INTEGRATION_CONFLICT');
  assert.equal(f.model.writes.length, 1);
  assert.equal(f.model.user.openai_base_url, 'https://another-user-choice.invalid');
  assert.equal(await readFile(f.filename, 'utf8'), saved);
  const result = await f.status();
  assert.equal(result.phase, 'conflict'); assert.equal(result.attached, false); assertPublic(result, f);
});

test('native CAS failure leaves recoverable pending evidence and a retry preserves unrelated concurrent edits', async t => {
  const f = await fixture(t);
  f.model.beforeWrite = async () => { f.model.user.unrelated = 'concurrent edit'; f.model.version++; f.model.beforeWrite = async () => {}; };
  await assert.rejects(f.install(), error => {
    assert.equal(error.code, 'NATIVE_INTEGRATION_WRITE_UNCONFIRMED');
    assert.ok(!error.message.includes(originalURL)); return true;
  });
  assert.equal((await f.record()).phase, 'install_pending');
  const pending = await f.status();
  assert.equal(pending.recoveryPending, true); assert.equal(pending.readyForNewThreads, false);
  assert.equal((await f.install()).readyForNewThreads, true);
  assert.equal(f.model.writes[1].expectedVersion, 'version-2');
  assert.equal(f.model.user.unrelated, 'concurrent edit');
  assert.equal((await f.record()).original.model_provider.value, 'custom');
});

test('a lost write response is recovered by readback without submitting a duplicate write', async t => {
  const f = await fixture(t);
  f.model.afterWrite = async () => { f.model.afterWrite = async () => {}; throw new Error(`connection lost ${gatewayURL(f.config)}`); };
  await assert.rejects(f.install(), error => error.code === 'NATIVE_INTEGRATION_WRITE_UNCONFIRMED' && !error.message.includes(f.config.token));
  assert.equal((await f.record()).phase, 'install_pending');
  assert.equal((await f.install()).phase, 'installed');
  assert.equal(f.model.writes.length, 1);
  f.model.afterWrite = async () => { f.model.afterWrite = async () => {}; throw new Error('lost removal response'); };
  await assert.rejects(f.remove(), error => error.code === 'NATIVE_INTEGRATION_WRITE_UNCONFIRMED');
  assert.equal((await f.record()).phase, 'remove_pending');
  assert.equal((await f.remove()).phase, 'removed');
  assert.equal(f.model.writes.length, 2);
});

test('an unapplied first install can be removed without touching native configuration', async t => {
  const f = await fixture(t), original = clone(f.model.user);
  f.model.beforeWrite = async () => { throw new Error('not submitted'); };
  await assert.rejects(f.install());
  const attempts = f.model.writes.length;
  assert.equal((await f.remove()).phase, 'removed');
  assert.equal(f.model.writes.length, attempts); assert.deepEqual(f.model.user, original);
});

test('removal restores absent keys by native null/replace and verifies their absence', async t => {
  const f = await fixture(t, { model: 'untouched', model_providers: { company: { preserved: true } } });
  const original = clone(f.model.user);
  await f.install();
  const record = await f.record();
  assert.deepEqual(record.original, { model_provider: { present: false }, openai_base_url: { present: false } });
  const result = await f.remove();
  assert.equal(result.restored, true); assert.deepEqual(f.model.user, original);
  assert.deepEqual(f.model.writes[1].edits, KEYS.map(key => ({ keyPath: key, value: null, mergeStrategy: 'replace' })));
  const writes = f.model.writes.length, connections = f.model.connections.length;
  await f.remove(); await f.status();
  assert.equal(f.model.writes.length, writes); assert.equal(f.model.connections.length, connections);
});

test('overridden writes are reported as not ready and never expose native override metadata', async t => {
  const f = await fixture(t);
  f.model.override = { model_provider: 'managed-choice', openai_base_url: originalURL };
  f.model.writeStatus = 'okOverridden';
  const result = await f.install();
  assert.equal(result.attached, true); assert.equal(result.readyForNewThreads, false);
  assert.equal(result.phase, 'overridden'); assert.equal(result.writeStatus, 'okOverridden'); assertPublic(result, f);
  assert.equal((await f.status()).phase, 'overridden');
  f.model.override = null;
  assert.equal((await f.status()).readyForNewThreads, true, 'A fresh native read can observe an override being removed');
});

test('only a unique enabled base user layer with an absolute path and version can be written', async t => {
  const f = await fixture(t);
  const variants = [
    response => ({ ...response, layers: null }),
    response => ({ ...response, layers: response.layers.filter(layer => layer.name.profile !== null) }),
    response => ({ ...response, layers: [...response.layers, clone(response.layers[1])] }),
    response => { response.layers[1].name.file = 'relative/config.toml'; return response; },
    response => { response.layers[1].version = ''; return response; },
    response => { response.layers[1].disabledReason = 'managed policy'; return response; },
  ];
  for (const transform of variants) {
    f.model.transformRead = transform;
    await assert.rejects(f.install(), error => error.code === 'NATIVE_INTEGRATION_INVALID_LAYER');
  }
  assert.equal(f.model.writes.length, 0);
  await assert.rejects(readFile(f.filename), error => error.code === 'ENOENT');
  assert.equal(f.model.closes, variants.length);
});

test('changing profiles or a pending target key fails closed without exposing any saved values', async t => {
  const f = await fixture(t);
  await f.install();
  f.model.file = path.join(f.directory, 'another-profile', 'config.toml');
  for (const action of [f.install, f.remove, f.status]) await assert.rejects(action(), error => error.code === 'NATIVE_INTEGRATION_PROFILE_CHANGED');
  assert.equal(f.model.writes.length, 1);
  f.model.file = f.profileFile;
  await f.remove();
  f.model.beforeWrite = async () => { throw new Error('interrupted before write'); };
  await assert.rejects(f.install());
  f.model.beforeWrite = async () => {};
  f.model.user.model_provider = 'another-person'; f.model.version++;
  await assert.rejects(f.install(), error => error.code === 'NATIVE_INTEGRATION_CONFLICT');
  assert.equal((await f.status()).recoverable, false);
});

test('a runtime that leaves JSON null as a present key cannot produce a false successful restoration', async t => {
  const f = await fixture(t, { model: 'keep' });
  await f.install(); f.model.nullDeletes = false;
  await assert.rejects(f.remove(), error => error.code === 'NATIVE_INTEGRATION_INVALID_LAYER');
  assert.equal((await f.record()).phase, 'remove_pending');
});

test('malformed private records do not leak their content and do not connect', async t => {
  const f = await fixture(t);
  await writeFile(f.filename, `not-json ${originalURL} ${f.config.token}`);
  await assert.rejects(f.status(), error => error.code === 'NATIVE_INTEGRATION_INVALID_RECORD'
    && !error.message.includes(originalURL) && !error.message.includes(f.config.token));
  assert.equal(f.model.connections.length, 0);
});

test('concurrent installs serialize private ownership and status remains read-only while a write is pending', async t => {
  const f = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { entered = resolve; });
  f.model.beforeWrite = async () => { f.model.beforeWrite = async () => {}; entered(); await gate; };
  const first = f.install();
  await writing;
  const recordBefore = await readFile(f.filename, 'utf8');
  const second = f.install();
  try {
    await delay(40);
    assert.equal(f.model.connections.length, 1, 'The second writer must not inspect a partially completed install');
    const status = await f.status();
    assert.equal(status.phase, 'install_pending'); assert.equal(status.readyForNewThreads, false);
    assert.equal(await readFile(f.filename, 'utf8'), recordBefore);
  } finally { release(); }
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.readyForNewThreads));
  assert.equal(f.model.writes.length, 1);
  assert.equal((await f.record()).original.openai_base_url.value, originalURL);
});

test('concurrent install and removal cannot replace the first originals with gateway defaults', async t => {
  const f = await fixture(t), original = clone(f.model.user);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { entered = resolve; });
  f.model.beforeWrite = async () => { f.model.beforeWrite = async () => {}; entered(); await gate; };
  const installing = f.install();
  await writing;
  const removing = f.remove();
  try {
    await delay(40);
    assert.equal(f.model.connections.length, 1);
  } finally { release(); }
  const [installed, removed] = await Promise.all([installing, removing]);
  assert.equal(installed.phase, 'installed'); assert.equal(removed.phase, 'removed');
  assert.equal(f.model.writes.length, 2); assert.deepEqual(f.model.user, original);
  assert.equal((await f.record()).original.openai_base_url.value, originalURL);
});

test('a live old lease is never stolen by age and only a proven dead owner is reaped', async t => {
  const f = await fixture(t), lockname = `${f.filename}.lock`;
  // The oldest lease this boot can hold; only pre-boot leases lose a live PID.
  const liveLease = JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() - uptime() * 1000 + 1000 });
  await writeFile(lockname, liveLease, { mode: 0o600 });
  const installing = f.install();
  try {
    await delay(40);
    assert.equal(f.model.connections.length, 0);
    assert.equal(await readFile(lockname, 'utf8'), liveLease);
  } finally { await unlink(lockname); }
  assert.equal((await installing).phase, 'installed');
  await f.remove();
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  await writeFile(lockname, JSON.stringify({ pid: child.pid, nonce: randomUUID(), at: Date.now() }), { mode: 0o600 });
  assert.equal((await f.install()).phase, 'installed');
  await assert.rejects(readFile(lockname), error => error.code === 'ENOENT');
});

test('already matching defaults without a record are tracked as a no-op rather than inventing prior values', async t => {
  const f = await fixture(t);
  f.model.user.model_provider = 'openai'; f.model.user.openai_base_url = gatewayURL(f.config);
  const before = clone(f.model.user);
  const result = await f.install();
  assert.equal(result.initialInstallWasNoOp, true); assert.equal(result.nativeWritePerformed, false);
  assert.equal(f.model.writes.length, 0);
  const removed = await f.remove();
  assert.equal(removed.initialInstallWasNoOp, true); assert.equal(removed.restored, true);
  assert.deepEqual(f.model.user, before); assert.equal(f.model.writes.length, 0);
});

test('explicit reconnect repairs original/owned mixtures with CAS and never replaces the first originals', async t => {
  const f = await fixture(t), original = clone(f.model.user);
  await f.install();
  const firstOriginal = clone((await f.record()).original);
  // CCSwitch commonly restores only this key while leaving the owned URL.
  f.model.user.model_provider = original.model_provider; f.model.version++;
  const unchanged = await readFile(f.filename, 'utf8');
  const status = await f.status();
  assert.equal(status.phase, 'conflict'); assert.equal(status.readyForNewThreads, false);
  assert.equal(await readFile(f.filename, 'utf8'), unchanged);
  await assert.rejects(f.install(), error => error.code === 'NATIVE_INTEGRATION_CONFLICT');
  assert.equal(f.model.writes.length, 1);
  let pending;
  f.model.beforeWrite = async () => { pending = await f.record(); };
  const result = await f.install({ reconnect: true });
  assert.equal(result.phase, 'installed'); assert.equal(result.readyForNewThreads, true);
  assert.equal(pending.phase, 'repair_pending'); assert.equal(pending.pending.operation, 'repair');
  assert.equal(f.model.writes[1].expectedVersion, 'version-3');
  assert.deepEqual((await f.record()).original, firstOriginal);
  assert.equal(f.model.user.model_provider, 'openai');
  assert.equal(f.model.user.openai_base_url, gatewayURL(f.config));
  await f.remove(); assert.deepEqual(f.model.user, original);
});

test('reconnect rejects unknown external values and absent ownership instead of broadening overwrite permission', async t => {
  const f = await fixture(t);
  await assert.rejects(f.install({ reconnect: true }), error => error.code === 'NATIVE_INTEGRATION_RECONNECT_UNAVAILABLE');
  assert.equal(f.model.connections.length, 0);
  await f.install();
  const record = await readFile(f.filename, 'utf8');
  for (const changes of [
    { model_provider: 'another-provider' },
    { model_provider: 'custom', openai_base_url: 'https://unrelated.invalid' },
  ]) {
    f.model.user = { model_provider: 'openai', openai_base_url: gatewayURL(f.config), ...changes }; f.model.version++;
    await assert.rejects(f.install({ reconnect: true }), error => error.code === 'NATIVE_INTEGRATION_CONFLICT');
    assert.equal(await readFile(f.filename, 'utf8'), record);
  }
  assert.equal(f.model.writes.length, 1);
  await assert.rejects(f.install({ reconnect: 'true' }), error => error.code === 'NATIVE_INTEGRATION_INVALID_OPTION');
});

test('pending repair resumes only its recorded before/after values and removal will not overwrite a mixed unapplied repair', async t => {
  const f = await fixture(t), original = clone(f.model.user);
  await f.install();
  f.model.user.model_provider = original.model_provider; f.model.version++;
  f.model.beforeWrite = async () => { throw new Error('repair interrupted before native write'); };
  await assert.rejects(f.install({ reconnect: true }), error => error.code === 'NATIVE_INTEGRATION_WRITE_UNCONFIRMED');
  const pending = await f.record();
  assert.equal(pending.phase, 'repair_pending'); assert.equal((await f.status()).recoverable, true);
  await assert.rejects(f.remove(), error => error.code === 'NATIVE_INTEGRATION_CONFLICT');
  assert.equal((await f.record()).phase, 'repair_pending');
  f.model.beforeWrite = async () => {};
  // This continues the explicitly requested persisted repair, not a new automatic repair.
  assert.equal((await f.install()).phase, 'installed');
  assert.deepEqual((await f.record()).original, pending.original);
  await f.remove(); assert.deepEqual(f.model.user, original);
});

test('a committed repair with a lost response can be removed after readback without losing originals', async t => {
  const f = await fixture(t), original = clone(f.model.user);
  await f.install();
  f.model.user.model_provider = original.model_provider; f.model.version++;
  f.model.afterWrite = async () => { f.model.afterWrite = async () => {}; throw new Error('lost repair response'); };
  await assert.rejects(f.install({ reconnect: true }), error => error.code === 'NATIVE_INTEGRATION_WRITE_UNCONFIRMED');
  assert.equal((await f.record()).phase, 'repair_pending');
  assert.equal((await f.remove()).phase, 'removed');
  assert.deepEqual(f.model.user, original); assert.equal(f.model.writes.length, 3);
});

test('pending repair validation rejects an unknown before value and does not connect', async t => {
  const f = await fixture(t);
  await f.install(); f.model.user.model_provider = 'custom'; f.model.version++;
  f.model.beforeWrite = async () => { throw new Error('pause'); };
  await assert.rejects(f.install({ reconnect: true }));
  const record = await f.record(), connections = f.model.connections.length;
  record.pending.before.model_provider.value = 'unowned-value';
  await atomicJSON(f.filename, record);
  for (const action of [f.status, f.install, f.remove]) await assert.rejects(action(), error => error.code === 'NATIVE_INTEGRATION_INVALID_RECORD');
  assert.equal(f.model.connections.length, connections);
});

test('reconnect handles recorded absence and a new gateway without losing the original removal target', async t => {
  const f = await fixture(t, { model: 'untouched' });
  await f.install();
  const updated = { ...f.config, id: randomUUID(), token: randomBytes(32).toString('hex') };
  await atomicJSON(configPath(f.directory), updated);
  delete f.model.user.model_provider; f.model.version++;
  const result = await f.install({ reconnect: true });
  assert.equal(result.readyForNewThreads, true); assert.equal(result.configId, updated.id);
  assert.equal(f.model.user.openai_base_url, gatewayURL(updated));
  assert.deepEqual((await f.record()).original, { model_provider: { present: false }, openai_base_url: { present: false } });
  await f.remove(); assert.deepEqual(f.model.user, { model: 'untouched' });
  const connections = f.model.connections.length;
  await assert.rejects(f.install({ reconnect: true }), error => error.code === 'NATIVE_INTEGRATION_RECONNECT_UNAVAILABLE');
  assert.equal(f.model.connections.length, connections);
});

test('route classification names only a coarse route kind, never a URL, path or token', () => {
  const owned = `http://127.0.0.1:15722/${'c'.repeat(64)}/v1`;
  const config = { model_provider: 'openai', openai_base_url: owned, model_providers: {
    custom: { name: 'custom', base_url: 'http://127.0.0.1:15721/v1', experimental_bearer_token: 'secret-bearer' },
    relay: { name: 'Relay A', base_url: 'https://relay.invalid/v1?key=secret-query' }, broken: { name: 'Broken', base_url: 'not a url' } } };
  assert.deepEqual(classifyRoute(config, null, owned), { kind: 'gateway' });
  assert.deepEqual(classifyRoute({ ...config, openai_base_url: undefined }, null, owned), { kind: 'openai' });
  assert.deepEqual(classifyRoute({ model_provider: 'custom', model_providers: config.model_providers }, null, owned), { kind: 'loopback', port: 15721, provider: 'custom' });
  assert.deepEqual(classifyRoute(config, 'relay', owned), { kind: 'custom', provider: 'Relay A' });
  assert.deepEqual(classifyRoute(config, 'broken', owned), { kind: 'unknown', provider: 'Broken' });
  assert.deepEqual(classifyRoute(config, 'oss', owned), { kind: 'unknown', provider: 'oss' });
  // A stale gateway capability is still loopback to the gateway port, not the gateway.
  assert.deepEqual(classifyRoute({ openai_base_url: `http://127.0.0.1:15722/${'d'.repeat(64)}/v1` }, null, owned), { kind: 'loopback', port: 15722, provider: 'openai' });
  const encoded = JSON.stringify(['custom', 'relay', 'broken'].map(id => classifyRoute(config, id, owned)));
  for (const secret of ['secret-bearer', 'secret-query', 'relay.invalid', '127.0.0.1', 'c'.repeat(64)]) assert.ok(!encoded.includes(secret));
});

test('startup description reads the effective route, a resumed thread provider and the login type without leaking values', async t => {
  const f = await fixture(t);
  await f.install();
  f.model.user.model_providers = { custom: { name: 'custom', base_url: 'http://127.0.0.1:15721/v1', experimental_bearer_token: 'secret-bearer' } };
  const thread = randomUUID(), requested = [];
  const connect = async (...args) => {
    const inner = await f.connect(...args);
    return { close: inner.close, request: async (method, params) => {
      requested.push(method);
      if (method === 'thread/read') return { thread: { id: params.threadId, modelProvider: 'custom' } };
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'private@example.invalid' } };
      return inner.request(method, params);
    } };
  };
  const plain = await nativeIntegrationStatus(f.directory, f.env, { connect });
  assert.equal(plain.effectiveRoute, undefined);
  assert.deepEqual(requested, ['config/read'], 'Ordinary status must not read threads or accounts');
  const described = await nativeIntegrationStatus(f.directory, f.env, { connect, describe: true, threadId: thread });
  assert.equal(described.readyForNewThreads, true);
  assert.deepEqual(described.effectiveRoute, { kind: 'gateway' });
  assert.deepEqual(described.threadRoute, { kind: 'loopback', port: 15721, provider: 'custom' });
  assert.equal(described.accountType, undefined, 'Login type is only read for an Official route');
  assertPublic(described, f);
  assert.ok(!JSON.stringify(described).includes('secret-bearer'));
  f.model.user.openai_base_url = undefined; delete f.model.user.openai_base_url;
  const official = await nativeIntegrationStatus(f.directory, f.env, { connect, describe: true });
  assert.deepEqual(official.effectiveRoute, { kind: 'openai' });
  assert.equal(official.accountType, 'chatgpt');
  assert.ok(!JSON.stringify(official).includes('private@example.invalid'));
});
