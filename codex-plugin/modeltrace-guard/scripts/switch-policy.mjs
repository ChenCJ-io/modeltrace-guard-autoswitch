import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { digest, readState, record, withState, segment, schedule } from './state.mjs';

const execute = promisify(execFile);
export const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const KEY = /^[a-z0-9][a-z0-9-]{0,23}$/;
const strong = sample => ['difference_signal', 'repeated_difference'].includes(sample?.outcome);
export const isVerification = state => state?.autoSwitch?.phase === 'verifying' && state.pending?.kind === 'fallback_verification';
export const isRecoveryActive = state => Boolean(state?.enabled && state.autoSwitch?.enabled && ['switch_pending', 'verifying'].includes(state.autoSwitch.phase));
export const haltBlocksProbe = state => Boolean(state?.taskHalt && !isVerification(state));
export const configPath = directory => path.join(directory, 'gateway-config.json');
export const runtimePath = directory => path.join(directory, 'gateway-runtime.json');

export async function atomicJSON(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function readJSON(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Read only provider identity metadata. Credential columns never leave SQLite.
export async function inspectCCSwitch(directory = path.join(homedir(), '.cc-switch')) {
  // SQLite derives booleans and hashes inside the DB. Neither API keys nor
  // auth objects/config text are returned to this process. Accept a narrow,
  // pristine native official card, not a third-party card named 'Official'.
  const query = `SELECT id,name,category,
    hex(sha3(settings_config || coalesce(meta,'{}') || coalesce(category,''),256)) AS fingerprint,
    (category='official' AND json_type(settings_config,'$.auth')='object'
      AND length(trim(coalesce(json_extract(settings_config,'$.auth.OPENAI_API_KEY'),'')))=0
      AND length(trim(coalesce(json_extract(settings_config,'$.config'),'')))=0
      AND length(trim(coalesce(json_extract(settings_config,'$.base_url'),'')))=0
      AND length(trim(coalesce(json_extract(settings_config,'$.baseUrl'),'')))=0
      AND length(trim(coalesce(json_extract(settings_config,'$.baseURL'),'')))=0) AS nativeOfficial
    FROM providers WHERE app_type='codex';
    SELECT listen_address,listen_port FROM proxy_config WHERE app_type='codex';`;
  // Separate queries keep sqlite3 JSON output one valid JSON document per call.
  const queries = query.split(';').filter(Boolean);
  const [providers, listener, live] = await Promise.all([
    ...queries.map(async sql => JSON.parse((await execute('sqlite3', ['-readonly', '-json', path.join(directory, 'cc-switch.db'), sql], { maxBuffer: 1024 * 1024 })).stdout || '[]')),
    readJSON(path.join(directory, 'live-state.json')),
  ]);
  const mode = live?.apps?.codex || {};
  return { directory: path.resolve(directory), providers, listener: listener[0] || null,
    mode: mode.mode || 'direct', attached: mode.attached === true, defaultProvider: mode.proxy_route || null,
    pending: Boolean(mode.pending), stack: mode.stack || { enabled: false, members: [], keys: {} } };
}

export function verifyLayout(config, layout) {
  if (layout.mode !== 'proxy' || !layout.attached || !layout.stack.enabled || layout.pending) throw new Error('CCSwitch must be attached in Aggregation mode with no pending config operation');
  if (layout.defaultProvider !== config.fallbackProvider) throw new Error('CCSwitch default provider changed; automatic routing is suspended');
  const fallback = layout.providers.find(p => p.id === config.fallbackProvider), source = layout.providers.find(p => p.id === config.sourceProvider);
  if (fallback?.nativeOfficial !== 1) throw new Error('Fallback must be a pristine native OpenAI Official card with empty connection config and no stored API key');
  if (source?.fingerprint !== config.sourceFingerprint || fallback.fingerprint !== config.fallbackFingerprint) throw new Error('CCSwitch provider configuration changed; reconfigure and explicitly re-authorize a new thread');
  if (!layout.providers.some(p => p.id === config.sourceProvider && p.category !== 'official')) throw new Error('Source must be an existing third-party Codex provider');
  if (!layout.stack.members?.includes(config.sourceProvider) || layout.stack.keys?.[config.sourceKey] !== config.sourceProvider) throw new Error('CCSwitch source aggregation member/key changed');
  if (layout.listener?.listen_address !== '127.0.0.1' || config.upstream !== `http://127.0.0.1:${layout.listener.listen_port}/v1`) throw new Error('CCSwitch listener must match the configured IPv4 loopback endpoint');
  return true;
}

export async function configureGateway(directory, { sourceProvider, fallbackProvider, ccSwitchDirectory = path.join(homedir(), '.cc-switch'), port = 15722 }, inspect = inspectCCSwitch) {
  if (!sourceProvider || !fallbackProvider || sourceProvider === fallbackProvider || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Provide distinct source/fallback providers and a port in 1024..65535');
  const layout = await inspect(ccSwitchDirectory);
  const sourceKey = Object.entries(layout.stack.keys || {}).find(([, id]) => id === sourceProvider)?.[0];
  if (!KEY.test(sourceKey || '')) throw new Error('Add the source provider to CCSwitch Aggregation first');
  const config = { schema: 1, id: randomUUID(), ccSwitchDirectory: path.resolve(ccSwitchDirectory), sourceProvider, fallbackProvider, sourceKey,
    sourceFingerprint: layout.providers.find(p => p.id === sourceProvider)?.fingerprint, fallbackFingerprint: layout.providers.find(p => p.id === fallbackProvider)?.fingerprint,
    port, upstream: `http://127.0.0.1:${layout.listener?.listen_port}/v1`, token: randomBytes(32).toString('hex') };
  if (port === layout.listener?.listen_port) throw new Error('Gateway and CCSwitch need different ports');
  verifyLayout(config, layout);
  validateGatewayConfig(config);
  await atomicJSON(configPath(directory), config);
  return publicConfig(config);
}

export const publicConfig = ({ token, ...config }) => config;
export function validateGatewayConfig(c) {
  if (!c || c.schema !== 1 || !UUID.test(c.id) || !/^[a-f0-9]{64}$/.test(c.token) || !KEY.test(c.sourceKey)
    || !/^[a-f0-9]{64}$/i.test(c.sourceFingerprint || '') || !/^[a-f0-9]{64}$/i.test(c.fallbackFingerprint || '')
    || !path.isAbsolute(c.ccSwitchDirectory || '') || !c.sourceProvider || !c.fallbackProvider || c.sourceProvider === c.fallbackProvider
    || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw new Error('Invalid gateway configuration');
  const url = new URL(c.upstream);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1' || url.search || url.hash || url.username || url.password || Number(url.port) === c.port) throw new Error('Gateway upstream must be the distinct CCSwitch loopback endpoint');
  return c;
}
export async function loadGatewayConfig(directory) { return validateGatewayConfig(await readJSON(configPath(directory))); }
export async function verifyGatewayReady(directory, config, inspect = inspectCCSwitch) {
  const current = await loadGatewayConfig(directory);
  if (current.id !== config.id) throw new Error('Gateway configuration changed; restart the gateway');
  verifyLayout(config, await inspect(config.ccSwitchDirectory));
}
export const gatewayURL = config => `http://127.0.0.1:${config.port}/${config.token}/v1`;

const receiptPath = (directory, thread) => path.join(directory, '_receipts', `${digest(thread)}.json`);
const bindingPath = (directory, thread) => path.join(directory, '_bindings', `${digest(thread)}.json`);
export const readReceipt = (directory, thread) => readJSON(receiptPath(directory, thread));
export async function saveReceipt(directory, config, receipt) {
  if (!UUID.test(receipt.threadId)) return;
  const allowed = ['threadId', 'requestId', 'route', 'revision', 'statusCode', 'startedAt', 'finishedAt', 'completed', 'success', 'responseEvent'];
  const safe = Object.fromEntries(allowed.filter(k => Object.hasOwn(receipt, k)).map(k => [k, receipt[k]]));
  await atomicJSON(receiptPath(directory, receipt.threadId), { ...safe, configId: config.id });
}

export async function resolveSessionRoute(directory, config, thread) {
  if (!UUID.test(thread)) throw new Error('A native thread-id is required');
  const binding = await readJSON(bindingPath(directory, thread));
  if (binding) {
    if (binding.expiresAt <= Date.now() || binding.configId !== config.id) throw new Error('Probe route binding expired or changed');
    const state = await readState(directory, binding.session);
    if (!state?.enabled || state.runtimePaused || state.compacting || state.runtimeEndedAt || state.pending?.id !== binding.challenge || state.autoSwitch?.policyId !== binding.policyId) throw new Error('Probe route binding no longer belongs to a live checkpoint');
    if (binding.route === 'fallback' && !isVerification(state) && state.autoSwitch?.route !== 'fallback') throw new Error('Fallback probe is not authorized');
    return { route: binding.route, sourceKey: config.sourceKey, revision: binding.revision };
  }
  const state = await readState(directory, thread);
  const policy = state?.autoSwitch;
  if (policy && policy.configId !== config.id) throw new Error('Thread routing policy belongs to another gateway configuration');
  // Threads which have not opted in stay on the official default. Never spend
  // company API credentials merely because a thread reached this gateway.
  return { route: policy?.route || 'fallback', sourceKey: config.sourceKey, revision: policy?.revision || 0 };
}

export async function enableAutoSwitch(directory, session, { accountType, modelProvider, model }, now = Date.now()) {
  if (!UUID.test(session) || accountType !== 'chatgpt' || modelProvider !== 'openai') throw new Error('Auto-switch requires a native ChatGPT-authenticated openai thread started through the gateway');
  const config = await loadGatewayConfig(directory);
  await verifyGatewayReady(directory, config);
  const receipt = await readReceipt(directory, session);
  if (!receipt || receipt.configId !== config.id || !receipt.success || receipt.route !== 'fallback' || now - receipt.finishedAt > 10 * 60 * 1000) throw new Error('No recent successful official request for this thread through the gateway; use launch first');
  return withState(directory, session, state => {
    if (state.taskHalt || state.pending || state.probeRun || state.confirmation?.status === 'active') throw new Error('Finish the current monitoring checkpoint/halt before enabling auto-switch');
    if (state.autoSwitch) throw new Error('This thread already has a route policy; no implicit re-arming or switch-back');
    state.model = state.expected = model; state.expectedSource = 'auto';
    state.enabled = true; state.startedAt ||= now; state.enabledAt = now; state.runtimePaused = false;
    state.config.retryCount = Math.max(3, state.config.retryCount);
    state.autoSwitch = { enabled: true, policyId: randomUUID(), configId: config.id, sourceProvider: config.sourceProvider,
      fallbackProvider: config.fallbackProvider, sourceKey: config.sourceKey, phase: 'armed', route: 'source', revision: 1,
      authorizedAt: now, attempts: 0, noticePending: false };
    segment(state, now, 'autoswitch_authorized');
    record(state, 'autoswitch_authorized', now, { policyId: state.autoSwitch.policyId, sourceProvider: config.sourceProvider, fallbackProvider: config.fallbackProvider });
    return state.autoSwitch;
  });
}

export function eligibleForSwitch(state) {
  const policy = state.autoSwitch, batch = state.confirmation;
  if (!policy?.enabled || policy.phase !== 'armed' || policy.attempts !== 0 || !state.taskHalt || !batch?.allMismatch || batch.target < 3 || batch.results.length !== batch.target) return false;
  const ids = [batch.id, ...batch.results.map(r => r.challenge)];
  const samples = ids.map(id => state.samples.find(s => s.challenge === id));
  return samples.every(s => s && strong(s) && s.expected === batch.expected && s.epoch === batch.epoch
    && s.fork?.routing?.route === 'source' && s.fork.routing.configId === policy.configId
    && s.fork.routing.policyId === policy.policyId && s.fork.routing.revision === policy.revision && s.fork.routing.success === true);
}

export function queueAutoSwitch(state, now) {
  if (!eligibleForSwitch(state)) return false;
  Object.assign(state.autoSwitch, { phase: 'switch_pending', haltId: state.taskHalt.id, queuedAt: now });
  record(state, 'autoswitch_queued', now, { haltId: state.taskHalt.id, policyId: state.autoSwitch.policyId });
  return true;
}

export function beginVerification(state, now) {
  const policy = state.autoSwitch;
  if (!policy?.enabled || policy.phase !== 'switch_pending' || !state.enabled || state.runtimePaused || state.runtimeEndedAt || state.compacting
    || state.pending || state.probeRun || state.alerts.some(a => !a.acknowledgedAt) || state.taskHalt?.id !== policy.haltId) return false;
  Object.assign(policy, { phase: 'verifying', attempts: 1, verificationStartedAt: now });
  // The old retry snapshot is cleaned up before this checkpoint. Verification
  // uses a new frozen native snapshot, not another retry in the old batch.
  state.pending = { id: randomUUID(), kind: 'fallback_verification', epoch: state.epoch, model: state.model, expected: state.expected,
    count: 300, language: state.confirmation.language, at: now, expiresAt: now + state.config.pendingSeconds * 1000, workTools: state.workTools };
  state.issued++; state.turnIssued++;
  record(state, 'autoswitch_verification_started', now, { challenge: state.pending.id, haltId: policy.haltId });
  return true;
}

export function failAutoSwitch(state, now, reason) {
  if (!['verifying', 'switch_pending'].includes(state.autoSwitch?.phase)) return;
  Object.assign(state.autoSwitch, { phase: 'failed', failedAt: now, reason });
  record(state, 'autoswitch_failed', now, { reason, haltId: state.autoSwitch.haltId });
}

export function finishVerification(state, sample, checkpoint, now) {
  const p = state.autoSwitch;
  if (checkpoint.kind !== 'fallback_verification') return false;
  const r = sample.fork?.routing;
  const success = p?.enabled && p.phase === 'verifying' && state.enabled && !state.runtimePaused && !state.compacting && !state.runtimeEndedAt
    && state.taskHalt?.id === p.haltId && r?.route === 'fallback' && r.success === true && r.configId === p.configId
    && r.policyId === p.policyId && r.revision === p.revision + 1
    && sample.expected === state.taskHalt.expected && sample.prediction === sample.expected && sample.outcome === 'compatible';
  if (!success) { failAutoSwitch(state, now, 'fallback_verification_failed'); return true; }
  p.phase = 'switched'; p.route = 'fallback'; p.revision++; p.switchedAt = now; p.noticePending = true;
  p.receipt = { requestId: r.requestId, threadId: r.threadId, finishedAt: r.finishedAt, prediction: sample.prediction };
  record(state, 'autoswitch_verified', now, { haltId: state.taskHalt.id, requestId: r.requestId, sourceProvider: p.sourceProvider, fallbackProvider: p.fallbackProvider });
  state.taskHalt = null;
  state.epoch++; state.forceProbe = false; schedule(state, now);
  return true;
}

export function switchControlContext(state, directory, runner) {
  const policy = state.autoSwitch;
  if (!state.taskHalt || !['switch_pending', 'verifying'].includes(policy?.phase)) return null;
  return `ModelTrace AutoSwitch: the user has authorized one automatic provider switch for this thread. Pause original work while the fallback is verified. Do not clear the halt manually. Report and acknowledge pending fingerprint notifications, then use the normal guard wait --confirmation ${JSON.stringify(state.confirmation.id)} command. The background worker runs the verification. Continue the existing task only after autoswitch_verified; a failed verification keeps the halt. State: ${policy.phase}.`;
}

export async function prepareSwitchTransport(directory, snapshot, pending) {
  const state = await readState(directory, snapshot.sourceSession);
  if (!state?.autoSwitch) return null;
  if (snapshot.provider !== 'openai') throw new Error('AutoSwitch probes require the native openai authentication contract');
  const config = await loadGatewayConfig(directory);
  if (config.id !== state.autoSwitch.configId) throw new Error('AutoSwitch configuration changed');
  await verifyGatewayReady(directory, config);
  const canary = pending.kind === 'fallback_verification';
  const route = canary ? 'fallback' : state.autoSwitch.route;
  const revision = state.autoSwitch.revision + (canary ? 1 : 0);
  let forkId;
  return {
    mode: 'autoswitch_gateway', url: gatewayURL(config),
    async authorize(id) {
      if (!UUID.test(id) || id === snapshot.sourceSession || id === snapshot.id) throw new Error('Only disposable probe forks may be bound');
      forkId = id;
      await atomicJSON(bindingPath(directory, id), { session: snapshot.sourceSession, configId: config.id, policyId: state.autoSwitch.policyId,
        challenge: pending.id, route, revision, expiresAt: pending.expiresAt });
    },
    async receipt() {
      // The HTTP stream can finish before the gateway fsync/rename is visible.
      // Wait only for this completed request's metadata, never start a probe.
      const deadline = Math.min(pending.expiresAt, Date.now() + 2000);
      let receipt;
      do {
        receipt = await readReceipt(directory, forkId);
        if (receipt?.startedAt >= pending.at) break;
        await delay(Math.max(1, Math.min(25, deadline - Date.now())));
      } while (Date.now() < deadline);
      if (!receipt || receipt.configId !== config.id || receipt.threadId !== forkId || receipt.route !== route || receipt.revision !== revision
        || receipt.startedAt < pending.at || !receipt.success || !receipt.completed) throw new Error('No completed successful gateway receipt for this native probe');
      await verifyGatewayReady(directory, config);
      return { ...receipt, policyId: state.autoSwitch.policyId };
    },
    async close() { if (forkId) await unlink(bindingPath(directory, forkId)).catch(e => { if (e.code !== 'ENOENT') throw e; }); },
  };
}
