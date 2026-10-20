import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { openAppServer } from './app-server-client.mjs';
import { gatewayURL, loadGatewayConfig, UUID } from './provider-config.mjs';
import { attemptStateLock, reapDeadLock, replaceStateFile } from './state.mjs';

const KEYS = ['model_provider', 'openai_base_url'];
const SAFE_ERROR = Symbol('nativeIntegrationError');
const PHASES = ['install_pending', 'update_pending', 'repair_pending', 'remove_pending', 'installed', 'removed'];
const recordPath = directory => path.join(directory, 'native-integration.json');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code, [SAFE_ERROR]: true });
const conflict = () => fail('NATIVE_INTEGRATION_CONFLICT', 'Native user configuration changed outside this integration; no values were overwritten');

function snapshot(config) {
  if (!plainObject(config)) throw fail('NATIVE_INTEGRATION_INVALID_LAYER', 'Native user configuration is not an object');
  return Object.fromEntries(KEYS.map(key => {
    const present = Object.hasOwn(config, key);
    // These native TOML keys are strings when present. A literal JSON null
    // cannot be restored as a present TOML value, so do not take ownership of it.
    if (present && typeof config[key] !== 'string') throw fail('NATIVE_INTEGRATION_INVALID_LAYER', 'Native route defaults have an unsupported value type');
    return [key, present ? { present: true, value: config[key] } : { present: false }];
  }));
}
const ownedSnapshot = owned => snapshot(owned);
const sameValue = (left, right) => left.present === right.present && (!left.present || left.value === right.value);
const sameSnapshot = (left, right) => KEYS.every(key => sameValue(left[key], right[key]));
const knownRepairValues = (values, record) => {
  const owned = ownedSnapshot(record.owned);
  return KEYS.every(key => sameValue(values[key], record.original[key]) || sameValue(values[key], owned[key]));
};
function validSnapshot(value) {
  return plainObject(value) && KEYS.every(key => plainObject(value[key]) && typeof value[key].present === 'boolean'
    && (value[key].present ? typeof value[key].value === 'string' : !Object.hasOwn(value[key], 'value')));
}
function validOwned(value) {
  if (!plainObject(value) || value.model_provider !== 'openai' || typeof value.openai_base_url !== 'string') return false;
  try {
    const url = new URL(value.openai_base_url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
      && /^\/[a-f0-9]{64}\/v1$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

async function loadRecord(directory) {
  let value;
  try { value = JSON.parse(await readFile(recordPath(directory), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail('NATIVE_INTEGRATION_INVALID_RECORD', 'Cannot read the private native integration record');
  }
  if (!value || value.schema !== 1 || !PHASES.includes(value.phase) || !UUID.test(value.configId || '')
    || typeof value.profileFile !== 'string' || !path.isAbsolute(value.profileFile)
    || !validOwned(value.owned) || !validSnapshot(value.original)) {
    throw fail('NATIVE_INTEGRATION_INVALID_RECORD', 'The private native integration record is invalid');
  }
  if (value.phase.endsWith('_pending')) {
    const pending = value.pending;
    if (!pending || value.phase !== `${pending.operation}_pending` || !['install', 'update', 'repair', 'remove'].includes(pending.operation)
      || !validSnapshot(pending.before) || !validSnapshot(pending.after) || !validOwned(pending.owned)
      || !UUID.test(pending.configId || '') || typeof pending.expectedVersion !== 'string' || !pending.expectedVersion
      || !(pending.operation === 'repair' ? knownRepairValues(pending.before, value)
        : sameSnapshot(pending.before, pending.operation === 'install' ? value.original : ownedSnapshot(value.owned)))
      || !sameSnapshot(pending.after, pending.operation === 'remove' ? value.original : ownedSnapshot(pending.owned))) {
      throw fail('NATIVE_INTEGRATION_INVALID_RECORD', 'The pending native integration record is invalid');
    }
  } else if (value.pending != null) {
    throw fail('NATIVE_INTEGRATION_INVALID_RECORD', 'The native integration record has an inconsistent pending operation');
  }
  return value;
}
async function saveRecord(directory, record) {
  const filename = recordPath(directory), temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ ...record, updatedAt: Date.now() }, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await replaceStateFile(temporary, filename);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function withIntegrationLock(directory, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${recordPath(directory)}.lock`, deadline = performance.now() + 5000;
  let lock;
  while (!lock) {
    const attempt = await attemptStateLock(filename);
    lock = attempt.lock;
    if (lock) break;
    // The shared reaper verifies a dead PID and claims this exact nonce;
    // neither an old timestamp nor an unreadable/empty lease is stealable.
    if (attempt.error.code === 'EEXIST' && await reapDeadLock(filename)) continue;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw fail('NATIVE_INTEGRATION_BUSY', 'Another native integration operation is still active; retry after it finishes');
    await delay(Math.min(remaining, 25));
  }
  const lease = JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() });
  let initialized = false;
  try {
    await lock.writeFile(lease); await lock.sync(); initialized = true;
    return await action();
  } finally {
    try { await lock.close(); }
    finally {
      if (!initialized || await readFile(filename, 'utf8').catch(() => null) === lease) {
        await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
}

async function readView(client, profileFile) {
  let response;
  try { response = await client.request('config/read', { includeLayers: true }); }
  catch { throw fail('NATIVE_INTEGRATION_READ_FAILED', 'Native configuration could not be read; any pending integration operation remains unconfirmed'); }
  const candidates = response?.layers?.filter(layer => layer?.name?.type === 'user' && layer.name.profile === null);
  if (!Array.isArray(candidates) || candidates.length !== 1 || !plainObject(response.config)) {
    throw fail('NATIVE_INTEGRATION_INVALID_LAYER', 'A unique base user configuration layer is required');
  }
  const layer = candidates[0], file = layer.name.file;
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof layer.version !== 'string' || !layer.version || layer.disabledReason != null) {
    throw fail('NATIVE_INTEGRATION_INVALID_LAYER', 'The base user layer needs an absolute file path and a native version');
  }
  if (profileFile && path.resolve(file) !== path.resolve(profileFile)) {
    throw fail('NATIVE_INTEGRATION_PROFILE_CHANGED', 'This integration belongs to a different native user configuration');
  }
  return { response, layer, file, values: snapshot(layer.config) };
}

async function currentGateway(directory) {
  try { return await loadGatewayConfig(directory); } catch { return null; }
}

function publicResult(record, view, config, writeStatus) {
  const base = { attached: false, readyForNewThreads: false, phase: record?.phase || 'not_installed',
    configId: record?.configId || null, profileFile: record?.profileFile || null,
    monitoringStarted: false, currentThreadChanged: false, scope: 'future_new_threads',
    initialInstallWasNoOp: record?.initialInstallWasNoOp === true };
  if (!record || record.phase === 'removed') return { ...base, ...(record ? { restored: true, lastWriteStatus: record.lastWriteStatus || null } : {}) };
  if (record.phase.endsWith('_pending')) {
    return { ...base, recoveryPending: true, recoverable: Boolean(view && (sameSnapshot(view.values, record.pending.before) || sameSnapshot(view.values, record.pending.after))) };
  }
  if (!view || !sameSnapshot(view.values, ownedSnapshot(record.owned))) return { ...base, phase: 'conflict' };
  const result = { ...base, attached: true, lastWriteStatus: record.lastWriteStatus || null };
  if (!config || config.id !== record.configId || gatewayURL(config) !== record.owned.openai_base_url) return { ...result, phase: 'stale_gateway_config' };
  const effectiveMatches = KEYS.every(key => view.response.config[key] === record.owned[key]);
  const origins = KEYS.map(key => view.response.origins?.[key]?.name);
  const originsKnown = origins.every(origin => plainObject(origin));
  const overriddenOrigin = originsKnown && origins.some(origin => origin.type !== 'user' || origin.profile !== null
    || origin.file !== record.profileFile);
  const overridden = writeStatus === 'okOverridden' || !effectiveMatches || overriddenOrigin
    || (!originsKnown && record.lastWriteStatus === 'okOverridden');
  return { ...result, phase: overridden ? 'overridden' : 'installed', overridden,
    readyForNewThreads: !overridden, ...(writeStatus ? { writeStatus } : {}) };
}

async function usingClient(env, connect, action) {
  let client, result, error;
  try {
    // Do not force nativeOpenai here: session flags would mask the actual
    // effective defaults that the integration is meant to inspect.
    client = await connect(env);
    result = await action(client);
  } catch (caught) {
    error = caught?.[SAFE_ERROR] ? caught : fail('NATIVE_INTEGRATION_FAILED', 'Native integration did not complete; inspect its private pending state before retrying');
  } finally {
    if (client) {
      try { await client.close(); }
      catch { error ||= fail('NATIVE_INTEGRATION_CLOSE_FAILED', 'The native configuration client did not close cleanly'); }
    }
  }
  if (error) throw error;
  return result;
}

async function settleApplied(directory, record, view) {
  if (!record?.phase.endsWith('_pending')) return record;
  if (sameSnapshot(view.values, record.pending.after)) {
    const pending = record.pending;
    record = { ...record, phase: pending.operation === 'remove' ? 'removed' : 'installed', pending: null,
      configId: pending.configId, owned: pending.owned, lastWriteStatus: pending.writeStatus || null };
    await saveRecord(directory, record);
    return record;
  }
  if (!sameSnapshot(view.values, record.pending.before)) throw conflict();
  return record;
}

async function writeAndVerify(directory, client, record, view) {
  const pending = record.pending;
  await saveRecord(directory, record); // Recovery evidence must precede the native write.
  let response;
  try {
    response = await client.request('config/batchWrite', {
      filePath: record.profileFile, expectedVersion: view.layer.version, reloadUserConfig: false,
      edits: KEYS.map(key => ({ keyPath: key, value: pending.after[key].present ? pending.after[key].value : null, mergeStrategy: 'replace' })),
    });
  } catch {
    throw fail('NATIVE_INTEGRATION_WRITE_UNCONFIRMED', 'Native configuration write was not confirmed; the pending record is preserved for recovery');
  }
  if (!['ok', 'okOverridden'].includes(response?.status) || typeof response.version !== 'string' || !response.version
    || typeof response.filePath !== 'string' || !path.isAbsolute(response.filePath) || path.resolve(response.filePath) !== path.resolve(record.profileFile)) {
    throw fail('NATIVE_INTEGRATION_WRITE_UNCONFIRMED', 'Native configuration returned an unverified write result; the pending record is preserved');
  }
  record.pending.writeStatus = response.status;
  record.pending.writeVersion = response.version;
  await saveRecord(directory, record);
  const after = await readView(client, record.profileFile);
  if (!sameSnapshot(after.values, pending.after)) throw conflict();
  record = await settleApplied(directory, record, after);
  return { ...publicResult(record, after, await currentGateway(directory), response.status), nativeWritePerformed: true };
}

export async function installNativeIntegration(directory, env = process.env, { connect = openAppServer, reconnect = false } = {}) {
  if (typeof reconnect !== 'boolean') throw fail('NATIVE_INTEGRATION_INVALID_OPTION', 'reconnect must be an explicit boolean');
  return withIntegrationLock(directory, () => installDefaults(directory, env, connect, reconnect));
}

async function installDefaults(directory, env, connect, reconnect) {
  const config = await currentGateway(directory);
  if (!config) throw fail('NATIVE_INTEGRATION_GATEWAY_MISSING', 'Configure the gateway before installing native defaults');
  const desired = { model_provider: 'openai', openai_base_url: gatewayURL(config) };
  let record = await loadRecord(directory);
  if (reconnect && !['installed', 'repair_pending'].includes(record?.phase)) {
    throw fail('NATIVE_INTEGRATION_RECONNECT_UNAVAILABLE', 'Explicit reconnect requires an installed integration or its pending repair');
  }
  return usingClient(env, connect, async client => {
    const view = await readView(client, record?.profileFile);
    record = await settleApplied(directory, record, view);
    let repairing = record?.phase === 'repair_pending';
    if (!record || record.phase === 'removed') {
      record = { schema: 1, phase: 'install_pending', profileFile: view.file, configId: config.id,
        original: view.values, owned: desired, pending: null, createdAt: Date.now(), lastWriteStatus: null,
        initialInstallWasNoOp: sameSnapshot(view.values, ownedSnapshot(desired)) };
    } else if (!record.phase.endsWith('_pending') && !sameSnapshot(view.values, ownedSnapshot(record.owned))) {
      if (!reconnect || record.phase !== 'installed' || !knownRepairValues(view.values, record)) throw conflict();
      repairing = true;
    }
    // A persisted repair carries the prior explicit reconnect through retries;
    // status/startup never call this writer. Other pending operations retain
    // their strict before/after checks in settleApplied.
    if (sameSnapshot(view.values, ownedSnapshot(desired))) {
      record = { ...record, phase: 'installed', configId: config.id, owned: desired, pending: null };
      await saveRecord(directory, record);
      return { ...publicResult(record, view, await currentGateway(directory)), nativeWritePerformed: false };
    }
    const operation = record.phase === 'install_pending' ? 'install' : repairing ? 'repair' : 'update';
    record = { ...record, phase: `${operation}_pending`, pending: {
      operation, before: view.values, after: ownedSnapshot(desired), owned: desired, configId: config.id, expectedVersion: view.layer.version,
    } };
    return writeAndVerify(directory, client, record, view);
  });
}

export async function nativeIntegrationStatus(directory, env = process.env, { connect = openAppServer } = {}) {
  const record = await loadRecord(directory);
  if (!record || record.phase === 'removed') return publicResult(record);
  return usingClient(env, connect, async client => publicResult(record, await readView(client, record.profileFile), await currentGateway(directory)));
}

export async function removeNativeIntegration(directory, env = process.env, { connect = openAppServer } = {}) {
  return withIntegrationLock(directory, () => removeDefaults(directory, env, connect));
}

async function removeDefaults(directory, env, connect) {
  let record = await loadRecord(directory);
  if (!record || record.phase === 'removed') return publicResult(record);
  return usingClient(env, connect, async client => {
    const view = await readView(client, record.profileFile);
    record = await settleApplied(directory, record, view);
    if (record.phase === 'removed') return publicResult(record);
    // A first install interrupted before its write has nothing to restore.
    if (record.phase === 'install_pending' && sameSnapshot(view.values, record.original)) {
      record = { ...record, phase: 'removed', pending: null };
      await saveRecord(directory, record);
      return publicResult(record);
    }
    if (!sameSnapshot(view.values, ownedSnapshot(record.owned))) throw conflict();
    if (sameSnapshot(view.values, record.original)) {
      record = { ...record, phase: 'removed', pending: null };
      await saveRecord(directory, record);
      return publicResult(record);
    }
    record = { ...record, phase: 'remove_pending', pending: {
      operation: 'remove', before: view.values, after: record.original, owned: record.owned, configId: record.configId, expectedVersion: view.layer.version,
    } };
    return writeAndVerify(directory, client, record, view);
  });
}
