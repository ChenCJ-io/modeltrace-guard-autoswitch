#!/usr/bin/env node
// Opt-in live smoke only. Never imported by the offline test suite or installer.
// This creates its own native conversation; it never resumes a user's thread.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// The caller must identify the installed cache, so source-checkout changes
// cannot make hook hash checks disagree with the plugin actually under test.
let AppServerClient, CODEX_CLIENT_INFO, codexExecutable, runAutoSwitch, gatewayStatus, loadArtifacts,
  requireTrustedGuard, requireTrustedStartupHook, nativeIntegrationStatus, loadGatewayConfig,
  verifyGatewayReady, defaultCardId, describeProvider, UUID, readReceipt, dataDirectory, isMismatch, readState, CLEANUP_SOURCE_KINDS;
async function loadInstalledPlugin(root) {
  const resolved = await realpath(root);
  const manifest = JSON.parse(await readFile(path.join(resolved, '.codex-plugin', 'plugin.json'), 'utf8'));
  if (manifest.name !== 'modeltrace-guard-autoswitch') throw failure('incorrect_installed_plugin');
  const module = name => import(pathToFileURL(path.join(resolved, 'scripts', `${name}.mjs`)).href);
  const modules = await Promise.all(['app-server-client', 'autoswitch', 'guard', 'fork-runner', 'startup',
    'native-integration', 'provider-config', 'switch-policy', 'state', 'fork-cleanup'].map(module));
  ({ AppServerClient, CODEX_CLIENT_INFO, codexExecutable } = modules[0]);
  ({ runAutoSwitch, gatewayStatus } = modules[1]); ({ loadArtifacts } = modules[2]);
  ({ requireTrustedGuard } = modules[3]); ({ requireTrustedStartupHook } = modules[4]);
  ({ nativeIntegrationStatus } = modules[5]); ({ loadGatewayConfig, verifyGatewayReady, defaultCardId, describeProvider, UUID } = modules[6]);
  ({ readReceipt } = modules[7]); ({ dataDirectory, isMismatch, readState } = modules[8]);
  ({ CLEANUP_SOURCE_KINDS } = modules[9]);
  if (typeof defaultCardId !== 'function') throw failure('installed_plugin_update_required');
  return { version: token(manifest.version) };
}

function optionsFor(args) {
  const options = { timeoutSeconds: 180, keepThread: false };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--help') return { help: true };
    if (flag === '--keep-thread' && !options.keepThread) { options.keepThread = true; continue; }
    if (flag === '--model' && !options.model) { options.model = args.shift(); continue; }
    if (flag === '--plugin-root' && !options.pluginRoot) { options.pluginRoot = args.shift(); continue; }
    if (flag === '--timeout-seconds' && !options.timeoutSet) {
      options.timeoutSeconds = Number(args.shift()); options.timeoutSet = true; continue;
    }
    throw failure('invalid_arguments');
  }
  if (typeof options.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(options.model)) throw failure('explicit_model_required');
  if (typeof options.pluginRoot !== 'string' || !path.isAbsolute(options.pluginRoot)) throw failure('absolute_installed_plugin_root_required');
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 60 || options.timeoutSeconds > 600) throw failure('invalid_timeout');
  return options;
}

const failure = code => Object.assign(new Error(code), { smokeCode: code });
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const responseEvents = new Set(['response.completed', 'response.failed', 'response.incomplete', 'response.error', 'error']);
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : null;
function receiptMetadata(receipt) {
  return receipt ? { statusCode: Number.isInteger(receipt.statusCode) ? receipt.statusCode : null,
    responseEvent: responseEvents.has(receipt.responseEvent) ? receipt.responseEvent : null,
    success: receipt.success === true, completed: receipt.completed === true,
    transport: receipt.transport === 'ccswitch' ? 'ccswitch' : receipt.transport === 'official' ? 'official' : null } : null;
}
function sampleMetadata(state) {
  const sample = state?.samples?.at(-1), request = state?.switchRequest;
  return { issued: state?.issued || 0, accepted: state?.samples?.length || 0,
    workTools: state?.workTools || 0, workHookObserved: Boolean(state?.lastWorkHookAt && state.lastWorkHookAt >= state.enabledAt),
    backgroundHookObserved: Boolean(state?.lastBackgroundHookAt && state.lastBackgroundHookAt >= state.enabledAt),
    outcome: token(sample?.outcome), expected: token(sample?.expected), fingerprintCandidate: token(sample?.prediction),
    checkpointAt: sample?.at || null, diagnosticStage: token(state?.forkHealth?.diagnostic?.stage),
    diagnosticCode: token(state?.forkHealth?.diagnostic?.code),
    switchRequest: request ? { id: request.id, status: token(request.status), target: request.target?.name || null,
      approved: Boolean(request.approval) } : null, taskHalted: Boolean(state?.taskHalt) };
}

// openAppServer is intentionally not used for this parent process: it marks
// management/probe clients with MODELTRACE_PROBE_PROCESS=1, suppressing hooks.
async function openNativeParent(env, cwd) {
  const childEnv = { ...env };
  for (const key of ['MODELTRACE_PROBE_PROCESS', 'CODEX_THREAD_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_AGENT_ID']) delete childEnv[key];
  const executable = await codexExecutable(childEnv);
  const child = spawn(executable, ['app-server', '--stdio'], { cwd, env: childEnv,
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new AppServerClient(child);
  try {
    await client.request('initialize', { clientInfo: CODEX_CLIENT_INFO, capabilities: { experimentalApi: true } });
    client.write({ method: 'initialized' });
    return client;
  } catch (error) { await client.close(); throw error; }
}

async function performTurn(client, threadId, text, deadline, { requireOK = false } = {}) {
  let resolve, reject, settled = false, turnId, completedId, finalIsOK = false, commandCompleted = false;
  const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
  completed.catch(() => {});
  const fail = code => { if (!settled) { settled = true; reject(failure(code)); } };
  const listener = message => {
    const p = message.params;
    if (p?.threadId !== threadId) return;
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
      if (['final', 'final_answer', null, undefined].includes(p.item.phase)) finalIsOK = p.item.text?.trim() === 'OK';
    }
    if (message.method === 'item/completed' && p.item?.type === 'commandExecution') {
      if (requireOK) return fail('unexpected_tool_in_first_turn');
      commandCompleted ||= p.item.status === 'completed' && p.item.exitCode === 0;
    }
    if (message.method === 'item/started' && ['fileChange', 'webSearch', 'imageGeneration', 'collabAgentToolCall', 'mcpToolCall', 'dynamicToolCall'].includes(p.item?.type)) {
      fail('unexpected_smoke_tool');
    }
    if (message.method === 'turn/completed') {
      if (turnId && p.turn?.id !== turnId) return;
      if (p.turn?.status !== 'completed') return fail('native_turn_failed');
      completedId = p.turn.id;
      if (!settled) { settled = true; resolve(); }
    }
    if (message.method === 'error' && !p.willRetry) fail('native_inference_failed');
  };
  client.listeners.add(listener);
  client.exited.then(() => fail('native_process_exited'));
  const timeout = setTimeout(() => fail('native_turn_timeout'), Math.max(1, deadline - Date.now()));
  try {
    const result = await client.request('turn/start', { threadId, input: [{ type: 'text', text }] }, Math.max(1, Math.min(15000, deadline - Date.now())));
    turnId = result.turn?.id;
    await completed;
    if (requireOK && !finalIsOK) throw failure('first_turn_did_not_reply_ok');
    return { id: completedId || turnId, commandCompleted };
  } finally { clearTimeout(timeout); client.listeners.delete(listener); }
}

// The smoke thread starts on CCSwitch's default card, which must stay the same
// card (and not personal Official, which is never monitored) during the run.
async function assertDefaultCard(directory, config, expected = null) {
  const current = await loadGatewayConfig(directory);
  if (current.id !== config.id) throw failure('configuration_changed');
  const layout = await verifyGatewayReady(directory, current);
  const id = defaultCardId(layout);
  if (expected && id !== expected) throw failure('ccswitch_default_card_changed');
  if (describeProvider(layout, id).transport === 'official') throw failure('default_card_is_official');
  return id;
}

async function waitStartReceipt(directory, session, config, cardId, deadline) {
  while (Date.now() < deadline) {
    const receipt = await readReceipt(directory, session);
    if (receipt) {
      if (receipt.configId !== config.id || receipt.providerId !== cardId) throw failure('unexpected_receipt_route');
      if (receipt.success && receipt.completed) return receipt;
      if (receipt.finishedAt) throw failure('first_request_failed');
    }
    await delay(200);
  }
  throw failure('first_receipt_timeout');
}

async function waitCheckpoint(directory, session, deadline, signal) {
  while (Date.now() < deadline && !signal.aborted) {
    const state = await readState(directory, session);
    if (state?.taskHalt || state?.switchRequest || isMismatch(state?.samples?.at(-1) || {})) return { kind: 'mismatch', state };
    if (state?.samples?.length) return { kind: 'sample', state };
    if (state?.forkHealth?.ready === false || state?.missed > 0 || (state?.pending && state.pending.expiresAt <= Date.now())) {
      return { kind: 'coverage_gap', state };
    }
    await delay(250);
  }
  return { kind: 'timeout', state: await readState(directory, session) };
}

async function ownThreadCleanup(client, directory, ownership, keepThread) {
  const deadline = Date.now() + 30000;
  let state;
  do {
    state = await readState(directory, ownership.id);
    if (!state?.probeRun && !state?.forkSnapshot && (!state?.forkCleanup || state.forkCleanup.status === 'deleted')) break;
    if (state?.forkCleanup?.status === 'blocked') return { deleted: false, reason: 'temporary_base_cleanup_blocked' };
    await delay(250);
  } while (Date.now() < deadline);
  if (state?.probeRun || state?.forkSnapshot || (state?.forkCleanup && state.forkCleanup.status !== 'deleted')) {
    return { deleted: false, reason: 'temporary_base_cleanup_unconfirmed' };
  }
  if (keepThread) return { deleted: false, reason: 'keep_thread_requested', baseCleanup: 'confirmed' };
  const { thread } = await client.request('thread/read', { threadId: ownership.id, includeTurns: false });
  if (thread?.id !== ownership.id || thread.ephemeral || thread.forkedFromId || thread.parentThreadId
    || thread.cwd !== ownership.cwd || thread.name !== ownership.name || !ownership.path || thread.path !== ownership.path) {
    return { deleted: false, reason: 'test_thread_ownership_changed' };
  }
  const boundary = async () => {
    const page = await client.request('thread/turns/list', { threadId: ownership.id, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
    return page.data?.[0];
  };
  const before = await boundary();
  if (!ownership.lastTurn || before?.id !== ownership.lastTurn || before.status === 'inProgress') {
    return { deleted: false, reason: 'test_thread_boundary_unconfirmed' };
  }
  for (const archived of [false, true]) {
    const page = await client.request('thread/list', { ancestorThreadId: ownership.id, limit: 1, archived,
      sourceKinds: [...CLEANUP_SOURCE_KINDS], modelProviders: [], useStateDbOnly: true });
    if (!Array.isArray(page.data) || page.data.length || page.nextCursor) return { deleted: false, reason: 'test_thread_descendants_unconfirmed' };
  }
  const after = await boundary();
  if (after?.id !== before.id || after.status !== before.status) return { deleted: false, reason: 'test_thread_changed_during_cleanup' };
  await client.request('thread/delete', { threadId: ownership.id }, 45000);
  return { deleted: true, baseCleanup: 'confirmed', reason: 'only_owned_test_thread_deleted' };
}

async function main() {
  const options = optionsFor(process.argv.slice(2));
  if (options.help) {
    emit({ usage: 'node scripts/verify-native-monitor.mjs --plugin-root INSTALLED_CACHE_PATH --model EXACT_BANK_LABEL [--timeout-seconds 180] [--keep-thread]',
      liveInference: true, scope: 'New isolated native thread on CCSwitch\'s default card only; real trusted hooks; no switch verification or switching.',
      cleanup: 'Disable normal test monitoring and delete only the owned thread after temporary-base and descendant checks. Mismatch evidence is retained.' });
    return;
  }
  const installed = await loadInstalledPlugin(options.pluginRoot);
  const env = { ...process.env };
  for (const key of ['MODELTRACE_PROBE_PROCESS', 'CODEX_THREAD_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_AGENT_ID']) delete env[key];
  const directory = dataDirectory(undefined, env), deadline = Date.now() + options.timeoutSeconds * 1000;
  const checkpointAbort = new AbortController(), startedAt = Date.now();
  let stage = 'preflight', client, cwd, config, cardId, ownership, enabled = false, preserveIncident = false,
    threadDeleted = false, result = 'failed', reason;
  const progress = details => emit({ stage, ...details });
  const heartbeat = setInterval(() => progress({ waiting: true, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) }), 15000);
  try {
    progress({ model: options.model, pluginVersion: installed.version, liveInference: true });
    config = await loadGatewayConfig(directory);
    cardId = await assertDefaultCard(directory, config);
    const connection = await nativeIntegrationStatus(directory, env);
    if (!connection.readyForNewThreads) throw failure('ordinary_entry_not_ready');
    const { bank } = await loadArtifacts();
    if (!bank.models.some(item => item.id === options.model)) throw failure('model_not_in_fingerprint_bank');
    cwd = await mkdtemp(path.join(tmpdir(), 'modeltrace-native-smoke-'));
    client = await openNativeParent(env, cwd);
    await requireTrustedStartupHook(client, cwd);
    await requireTrustedGuard(client, cwd);
    stage = 'create_native_thread';
    const started = await client.request('thread/start', { model: options.model, modelProvider: 'openai', allowProviderModelFallback: false,
      cwd, runtimeWorkspaceRoots: [cwd], sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false,
      developerInstructions: 'This is an isolated ModelTrace native smoke test. Follow only the current short test request. Do not read files, inspect credentials, access network tools, edit files, delegate, or run plugin management commands. When requested, execute only the shell command pwd once. If ModelTrace reports a mismatch, stop and report it without acknowledging, approving, declining, or switching.' }, 30000);
    const thread = started.thread;
    if (!UUID.test(thread?.id || '') || thread.ephemeral || thread.forkedFromId || thread.parentThreadId
      || started.model !== options.model || started.modelProvider !== 'openai' || thread.cwd !== cwd) throw failure('native_thread_identity_mismatch');
    ownership = { id: thread.id, cwd, path: thread.path, name: `ModelTrace smoke ${new Date().toISOString()} ${randomUUID().slice(0, 8)}`, lastTurn: null };
    await client.request('thread/name/set', { threadId: thread.id, name: ownership.name });
    progress({ session: ownership.id, name: ownership.name });
    const gateway = await gatewayStatus(directory);
    if (!gateway.running || gateway.readiness !== 'ready') throw failure('gateway_not_ready_after_startup_hook');
    await assertDefaultCard(directory, config, cardId);
    stage = 'first_native_response'; progress({ session: ownership.id });
    const first = await performTurn(client, ownership.id, 'Reply exactly OK. Do not use tools.', Math.min(deadline, Date.now() + 60000), { requireOK: true });
    ownership.lastTurn = first.id;
    const receipt = await waitStartReceipt(directory, ownership.id, config, cardId, Math.min(deadline, Date.now() + 10000));
    const { thread: persisted } = await client.request('thread/read', { threadId: ownership.id, includeTurns: false });
    ownership.path = persisted.path;
    progress({ receipt: receiptMetadata(receipt) });
    stage = 'enable_monitoring';
    const used = await runAutoSwitch(['use', '--session', ownership.id], { ...env, CODEX_THREAD_ID: ownership.id });
    if (!used.monitoringEnabled || used.switchApproved || used.autoSwitch?.current?.id !== cardId) throw failure('monitoring_not_enabled_on_start_card');
    enabled = true; progress({ monitoringEnabled: true, switchApproved: false });
    stage = 'native_work_tool_and_background_checkpoint'; progress({ session: ownership.id });
    const toolTurn = performTurn(client, ownership.id, 'Run the shell command pwd exactly once in the current directory. Do not run any other command or read any file. Then reply DONE.', deadline);
    toolTurn.catch(() => {});
    const checkpointPromise = waitCheckpoint(directory, ownership.id, deadline, checkpointAbort.signal);
    const firstResult = await Promise.race([toolTurn.then(turn => ({ kind: 'turn', turn })), checkpointPromise]);
    let checkpoint;
    if (firstResult.kind === 'mismatch') { checkpoint = firstResult; preserveIncident = true; }
    else {
      const turn = firstResult.kind === 'turn' ? firstResult.turn : await toolTurn;
      ownership.lastTurn = turn.id;
      if (!turn.commandCompleted) throw failure('native_pwd_tool_not_observed');
      checkpoint = await checkpointPromise;
      preserveIncident = checkpoint.kind === 'mismatch';
    }
    progress({ checkpoint: checkpoint.kind, ...sampleMetadata(checkpoint.state) });
    if (preserveIncident) { result = 'mismatch_requires_user_decision'; reason = 'incident_preserved_no_switch_approved'; }
    else if (checkpoint.kind !== 'sample') { result = 'coverage_gap'; reason = checkpoint.kind === 'timeout' ? 'checkpoint_timeout' : 'checkpoint_failed'; }
    else if (!checkpoint.state.lastWorkHookAt || checkpoint.state.lastWorkHookAt < checkpoint.state.enabledAt
      || !checkpoint.state.lastBackgroundHookAt || checkpoint.state.lastBackgroundHookAt < checkpoint.state.enabledAt) {
      result = 'coverage_gap'; reason = 'native_work_and_background_hooks_unconfirmed';
    } else { result = 'passed'; reason = 'native_response_and_hook_checkpoint_completed'; }
  } catch (error) {
    reason = error.smokeCode || 'stage_failed';
    const state = ownership ? await readState(directory, ownership.id).catch(() => null) : null;
    preserveIncident ||= Boolean(state?.taskHalt || state?.switchRequest || isMismatch(state?.samples?.at(-1) || {}));
    if (preserveIncident) result = 'mismatch_requires_user_decision';
    progress({ result, reason, ...(ownership ? { session: ownership.id,
      receipt: receiptMetadata(await readReceipt(directory, ownership.id).catch(() => null)), ...sampleMetadata(state) } : {}) });
  } finally {
    checkpointAbort.abort();
    stage = 'cleanup';
    if (ownership && client && !preserveIncident) {
      try {
        if (enabled) await runAutoSwitch(['disable', '--session', ownership.id], { ...env, CODEX_THREAD_ID: ownership.id });
        const cleanup = await ownThreadCleanup(client, directory, ownership, options.keepThread);
        threadDeleted = cleanup.deleted === true;
        progress({ session: ownership.id, monitoringDisabled: enabled, ...cleanup });
      } catch { progress({ session: ownership.id, deleted: false, reason: 'cleanup_unconfirmed_thread_retained' }); }
    } else if (ownership) progress({ session: ownership.id, deleted: false, reason: 'incident_evidence_retained' });
    try { await client?.close(); }
    catch { progress({ reason: 'native_process_cleanup_unconfirmed' }); }
    if (ownership && preserveIncident) {
      const state = await readState(directory, ownership.id).catch(() => null);
      progress({ session: ownership.id, retainedIncident: sampleMetadata(state),
        note: 'Closing the native runtime may mark a pending incident interrupted. Evidence is retained; no approval, decline, or route switch was performed.' });
    }
    // rmdir only removes this exact empty directory, never user files or trees.
    if (cwd && (!ownership || threadDeleted) && !options.keepThread) await rmdir(cwd).catch(() => {});
    clearInterval(heartbeat);
    emit({ result, reason, stage: 'finished', session: ownership?.id || null });
    process.exitCode = result === 'passed' ? 0 : 1;
  }
}

main().catch(error => { emit({ result: 'failed', stage: 'arguments', reason: error.smokeCode || 'startup_failed' }); process.exitCode = 1; });
