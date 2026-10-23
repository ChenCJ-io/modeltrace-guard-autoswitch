#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { dataDirectory, readState, withState, stopMonitoring } from './state.mjs';
import { openAppServer, codexExecutable } from './app-server-client.mjs';
import { sourceSettings } from './fork-snapshot.mjs';
import { requireTrustedGuard } from './fork-runner.mjs';
import { loadArtifacts } from './guard.mjs';
import { GATEWAY_IMPLEMENTATION_VERSION, gatewayRuntimeProblem, startSwitchGateway } from './switch-gateway.mjs';
import { installNativeIntegration, nativeIntegrationStatus, removeNativeIntegration } from './native-integration.mjs';
import { createOfficialNetwork, officialNetworkStatus, writeNetworkSetting } from './network-route.mjs';
import {
  UUID, atomicJSON, assertProviderCurrent, configureGateway, gatewayURL, inspectCCSwitch,
  loadGatewayConfig, publicConfig, readJSON, resolveProvider, runtimePath, verifyGatewayReady, verifyGatewayRoute,
} from './provider-config.mjs';
import {
  enableAutoSwitch, failAutoSwitch, readReceipt, resolveSessionRoute, saveReceipt,
} from './switch-policy.mjs';

const entrypoint = fileURLToPath(import.meta.url);
function argumentsFor(args) {
  const command = args.shift() || 'help', options = {};
  const allowed = {
    help: [], inspect: ['cc-switch-dir'], configure: ['primary-name', 'backup-name', 'primary-provider', 'backup-provider', 'cc-switch-dir', 'port'],
    connect: [], disconnect: [], 'connection-status': [], network: ['official-proxy'],
    'gateway-start': [], 'gateway-stop': [], 'gateway-status': [], serve: [], use: ['session'], enable: ['session'], disable: ['session'], status: ['session'], launch: ['resume', 'provider-name', 'provider-id'],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown command');
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith('--') || !args.length || Object.hasOwn(options, flag.slice(2)) || !['data-dir', ...allowed[command]].includes(flag.slice(2))) throw new Error(`Invalid option ${flag}`);
    const value = args.shift();
    if (!value.trim() || value.includes('\0') || value.startsWith('--')) throw new Error(`Invalid value for ${flag}`);
    options[flag.slice(2)] = value;
  }
  if (command === 'configure') {
    const names = ['primary-name', 'backup-name'], ids = ['primary-provider', 'backup-provider'];
    const hasNames = names.some(key => Object.hasOwn(options, key)), hasIds = ids.some(key => Object.hasOwn(options, key));
    if (hasNames === hasIds || !(hasNames ? names : ids).every(key => Object.hasOwn(options, key))) {
      throw new Error('Provide both --primary-name/--backup-name or both --primary-provider/--backup-provider; do not mix names and IDs');
    }
  }
  if (command === 'launch' && options['provider-name'] && options['provider-id']) throw new Error('Choose --provider-name or --provider-id, not both');
  return { command, options };
}

async function controlRequest(config, action, method = 'GET') {
  const response = await fetch(`${gatewayURL(config)}/${action}`, { method, redirect: 'error', signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('Gateway control request failed');
  return response.json();
}
export async function gatewayStatus(directory) {
  const config = await loadGatewayConfig(directory), runtime = await readJSON(runtimePath(directory));
  try {
    const health = await controlRequest(config, 'health');
    if (!runtime || health.instanceId !== runtime.instanceId || runtime.configId !== config.id) return { running: false, reason: 'gateway_instance_mismatch' };
    if (health.implementationVersion !== GATEWAY_IMPLEMENTATION_VERSION || runtime.implementationVersion !== GATEWAY_IMPLEMENTATION_VERSION) {
      return { running: true, readiness: 'upgrade_required', pid: runtime.pid, instanceId: runtime.instanceId,
        port: config.port, configId: config.id, implementationVersion: health.implementationVersion || null,
        expectedVersion: GATEWAY_IMPLEMENTATION_VERSION,
        instruction: 'The owned gateway still runs an older implementation. Stop this gateway and start it from the installed updated plugin; preserve its configuration and existing thread routes.' };
    }
    let readiness = 'ready';
    try { await verifyGatewayRoute(directory, config); } catch (error) { readiness = error.message; }
    return { running: true, readiness, pid: runtime.pid, instanceId: runtime.instanceId, port: config.port, configId: config.id,
      implementationVersion: GATEWAY_IMPLEMENTATION_VERSION };
  } catch { return { running: false, reason: 'gateway_unreachable', port: config.port }; }
}

export async function startGateway(directory) {
  const current = await gatewayStatus(directory);
  if (current.readiness === 'upgrade_required') throw new Error('Gateway upgrade required: stop the owned gateway, then start it from the updated installed plugin');
  if (current.running) return current;
  const runtime = gatewayRuntimeProblem();
  if (runtime) throw new Error(`${runtime}. Put a newer node first on the PATH that Codex hooks use, or run disconnect to restore the previous provider`);
  const config = await loadGatewayConfig(directory);
  // Starting the shared transport must not strand an already selected Official
  // thread when only the company default has drifted. Requests verify their route.
  await verifyGatewayReady(directory, config);
  const child = spawn(process.execPath, [entrypoint, 'serve', '--data-dir', directory], { detached: true, stdio: 'ignore', windowsHide: true });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  for (let n = 0; n < 60; n++) {
    if (spawnError) throw new Error('Could not start gateway process');
    const status = await gatewayStatus(directory);
    if (status.running) return status;
    await delay(100);
  }
  // Only our own newly created process is eligible for this cleanup.
  child.kill();
  throw new Error('Gateway did not become ready; check whether the configured port is occupied');
}

async function serveGateway(directory) {
  const runtime = gatewayRuntimeProblem();
  if (runtime) throw new Error(runtime);
  const config = await loadGatewayConfig(directory), instanceId = randomUUID();
  await verifyGatewayReady(directory, config);
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const gateway = await startSwitchGateway({ upstream: config.upstream, port: config.port, token: config.token, instanceId,
    verifyReady: route => verifyGatewayRoute(directory, config, route),
    resolveRoute: (thread, initialProviderId) => resolveSessionRoute(directory, config, thread, initialProviderId),
    onReceipt: receipt => saveReceipt(directory, config, receipt),
    // The spawning hook/tool call may lack the user's proxy variables; resolve
    // the saved setting and OS system proxy here, re-read without a restart.
    officialNetwork: createOfficialNetwork({ directory }),
    onShutdown: () => resolveDone(),
  });
  await atomicJSON(runtimePath(directory), { instanceId, configId: config.id, pid: process.pid, port: config.port,
    implementationVersion: GATEWAY_IMPLEMENTATION_VERSION, startedAt: Date.now() });
  const stop = () => resolveDone();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await done; }
  finally {
    await gateway.close();
    const runtime = await readJSON(runtimePath(directory));
    if (runtime?.instanceId === instanceId) await unlink(runtimePath(directory)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

function requestFailure(receipt) {
  if (receipt.success === true && receipt.completed === true) return null;
  const status = receipt.statusCode;
  if (receipt.transport === 'official' && receipt.transportError) return { reason: 'official_network_unreachable',
    hint: `The gateway could not connect to OpenAI Official (${receipt.transportError}, network ${receipt.networkSource || 'unknown'}). This is a local network/proxy problem, not the account or a fingerprint. Run autoswitch.mjs network to see the gateway's egress; set one with network --official-proxy only on the user's request.` };
  if (status === 401) return { reason: 'upstream_authentication_failed',
    hint: 'The selected route returned HTTP 401. Check the current native authentication and CCSwitch card configuration; do not copy credentials between profiles.' };
  if (status === 403) return { reason: 'upstream_forbidden',
    hint: 'The selected route returned HTTP 403. Inspect Codex client header/transport compatibility and CCSwitch forwarding before concluding that this account cannot use Codex. Starting another conversation alone does not repair this failure.' };
  if (status === 429) return { reason: 'upstream_rate_limited',
    hint: 'The selected route returned HTTP 429. Check its rate limits or capacity; no fallback request or switch has been authorized.' };
  if (status === 504) return { reason: 'gateway_request_timeout',
    hint: 'The gateway request timed out. Check the selected upstream and local proxy availability.' };
  if (Number.isInteger(status) && status >= 400) return { reason: 'gateway_http_failure',
    hint: 'The gateway request received an HTTP error. Inspect the selected upstream and CCSwitch transport; this is not fingerprint mismatch evidence.' };
  if (['response.failed', 'response.incomplete', 'response.error', 'error'].includes(receipt.responseEvent)) return { reason: 'upstream_response_failed',
    hint: 'The upstream response reported failure or incomplete generation. HTTP success alone does not make a usable monitoring receipt.' };
  if (!receipt.completed) return { reason: 'gateway_response_interrupted',
    hint: 'The gateway response did not finish. Check cancellation or transport interruption before retrying the current route.' };
  return { reason: 'response_completion_unconfirmed',
    hint: 'The gateway response has no verified successful response.completed outcome. Monitoring remains off until a successful primary response is recorded.' };
}

function publicReceipt(receipt, state, config) {
  if (!receipt) return null;
  const identities = [state?.autoSwitch?.current, state?.autoSwitch?.primary, state?.autoSwitch?.backup,
    state?.initialRoute?.provider, config?.primary, config?.backup];
  const provider = identities.find(candidate => candidate?.id === receipt.providerId);
  const failure = requestFailure(receipt);
  // Only fixed diagnostics and receipt metadata leave this boundary. Never
  // surface arbitrary upstream error bodies, URLs or authentication headers.
  return { provider: provider?.name || receipt.providerId, transport: receipt.transport,
    completed: receipt.completed === true, success: receipt.success === true,
    statusCode: Number.isInteger(receipt.statusCode) && receipt.statusCode >= 100 && receipt.statusCode <= 599 ? receipt.statusCode : null,
    responseEvent: ['response.completed', 'response.failed', 'response.incomplete', 'response.error', 'error'].includes(receipt.responseEvent) ? receipt.responseEvent : null,
    transportError: typeof receipt.transportError === 'string' ? receipt.transportError : null,
    networkSource: typeof receipt.networkSource === 'string' ? receipt.networkSource : null,
    finishedAt: receipt.finishedAt, configurationMatches: config ? receipt.configId === config.id : null,
    failureReason: failure?.reason || null, failureHint: failure?.hint || null,
    scope: 'most_recent_gateway_request_only' };
}

async function connectionDiagnostic(directory, env, openClient) {
  return nativeIntegrationStatus(directory, env, { connect: openClient })
    .catch(() => ({ readyForNewThreads: false, phase: 'unavailable' }));
}

export async function runAutoSwitch(args, env = process.env, {
  openClient = openAppServer, executableFor = codexExecutable, spawnClient = spawn,
} = {}) {
  const { command, options } = argumentsFor([...args]);
  const directory = dataDirectory(options['data-dir'], env);
  if (command === 'help') return { commands: ['inspect', 'configure', 'connect', 'disconnect', 'connection-status', 'network', 'use', 'gateway-start', 'gateway-stop', 'gateway-status', 'launch', 'enable', 'disable', 'status'],
    network: 'network [--official-proxy auto|direct|http(s)://HOST:PORT] (show or set how the gateway reaches OpenAI Official; auto = gateway HTTPS_PROXY, then the OS system proxy, then direct; applies without a restart or configuration change)',
    use: 'Natural-language entry: use enables monitoring only for this already-connected thread; it never launches another CLI or approves a switch.',
    connect: 'One-time setup for ordinary codex: connect this Codex home\'s future new conversations to the gateway. Existing running threads are unchanged; monitoring remains off.',
    disconnect: 'Restore only the two defaults still owned by this plugin. Existing gateway conversations and monitoring are unchanged; the gateway stays running.',
    configure: 'configure --primary-name NAME --backup-name NAME (or --primary-provider ID --backup-provider ID) [--cc-switch-dir PATH] [--port 15722]',
    launch: 'launch [--resume THREAD_ID] [--provider-name NAME | --provider-id ID] (default: primary; no global config edits)',
    enable: 'enable [--session THREAD_ID] (monitor an already successful primary-route thread; never changes its route)',
    disable: 'Stop monitoring and cancel a pending switch request; keep the selected route and any halt',
    incidents: 'Use guard.mjs propose-switch / approve-switch / decline-switch / wait-switch for an incident request',
    switching: 'On an explicit user request, guard.mjs switch-route --target-name NAME verifies the target (receipt + fingerprint) and then moves only this thread; failure keeps the current route',
    scope: 'Pause on the first valid fingerprint mismatch. Each target verification and switch requires consent for that incident. Configuration, enable and acknowledgement never approve a switch.', dataDirectory: directory };
  if (command === 'inspect') return inspectCCSwitch(options['cc-switch-dir']);
  if (command === 'connection-status') return nativeIntegrationStatus(directory, env, { connect: openClient });
  if (command === 'disconnect') return removeNativeIntegration(directory, env, { connect: openClient });
  if (command === 'connect') {
    if (directory !== dataDirectory(undefined, env)) {
      throw new Error('Ordinary codex startup must discover the same data directory. Use this Codex home default or the same MODELTRACE_AUTOSWITCH_DATA environment for both setup and ordinary codex; a command-only --data-dir cannot be connected');
    }
    const runtime = gatewayRuntimeProblem();
    if (runtime) throw new Error(`${runtime}. Upgrade Node before connecting ordinary Codex; nothing was changed`);
    const config = await loadGatewayConfig(directory);
    const layout = await verifyGatewayRoute(directory, config);
    const client = await openClient(env, { nativeOpenai: true });
    try {
      const { account } = await client.request('account/read', { refreshToken: false });
      if (account?.type !== 'chatgpt') throw new Error('This native Codex process did not read a ChatGPT login. Check the active Codex home/provider; do not infer that the user has never signed in');
      const { requireTrustedStartupHook } = await import('./startup.mjs');
      await requireTrustedStartupHook(client, process.cwd());
    } finally { await client.close(); }
    await startGateway(directory);
    const connection = await nativeIntegrationStatus(directory, env, { connect: openClient });
    const reconnect = layout.defaultProvider === config.primary.id && ['installed', 'conflict', 'repair_pending'].includes(connection.phase);
    return installNativeIntegration(directory, env, { connect: openClient, reconnect });
  }
  if (command === 'configure') {
    const current = await gatewayStatus(directory).catch(() => ({ running: false }));
    if (current.running) throw new Error('Stop this gateway before reconfiguring it');
    return configureGateway(directory, { primaryName: options['primary-name'], backupName: options['backup-name'],
      sourceProvider: options['primary-provider'], fallbackProvider: options['backup-provider'],
      ccSwitchDirectory: options['cc-switch-dir'], port: options.port === undefined ? 15722 : Number(options.port) });
  }
  if (command === 'network') {
    // Egress is not route identity: no stopped gateway, new config ID or route migration.
    if (options['official-proxy'] !== undefined) await writeNetworkSetting(directory, options['official-proxy']);
    return officialNetworkStatus(directory, { env });
  }
  if (command === 'serve') { await serveGateway(directory); return { stopped: true }; }
  if (command === 'gateway-start') return startGateway(directory);
  if (command === 'gateway-status') return gatewayStatus(directory);
  if (command === 'gateway-stop') {
    const status = await gatewayStatus(directory);
    if (!status.running) return { stopped: false, reason: status.reason };
    const config = await loadGatewayConfig(directory);
    await controlRequest(config, 'shutdown', 'POST');
    for (let n = 0; n < 30; n++) {
      if (!(await gatewayStatus(directory)).running) return { stopped: true };
      await delay(100);
    }
    throw new Error('Gateway shutdown not yet confirmed');
  }
  if (command === 'launch') {
    if (options.resume && !UUID.test(options.resume)) throw new Error('Invalid native thread ID');
    const config = await loadGatewayConfig(directory);
    const layout = await verifyGatewayReady(directory, config);
    const explicitProvider = Boolean(options['provider-name'] || options['provider-id']);
    const provider = explicitProvider ? resolveProvider(layout, { name: options['provider-name'], id: options['provider-id'] }) : config.primary;
    assertProviderCurrent(layout, provider);
    const executable = await executableFor(env);
    const client = await openClient(env, { nativeOpenai: true });
    try {
      const { account } = await client.request('account/read', { refreshToken: false });
      if (account?.type !== 'chatgpt') throw new Error('Sign into the native Codex client with ChatGPT before launch');
    } finally { await client.close(); }
    await startGateway(directory);
    // Recheck the chosen descriptor after runtime preparation. Neither a
    // changed card nor an unrelated global default may substitute this choice.
    assertProviderCurrent(await verifyGatewayReady(directory, config), provider);
    // argv is passed directly; never build a shell command or persist the URL
    // to the user's shared Codex or CCSwitch configuration.
    const child = spawnClient(executable, ['-c', 'model_provider="openai"', '-c', `openai_base_url=${JSON.stringify(gatewayURL(config, explicitProvider ? provider.id : undefined))}`,
      ...(options.resume ? ['resume', options.resume] : [])], { stdio: 'inherit', env: { ...env, MODELTRACE_AUTOSWITCH_DATA: directory } });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    return { exited: true, code };
  }
  const session = options.session || env.CODEX_THREAD_ID;
  if (!UUID.test(session || '') || (env.CODEX_THREAD_ID && session !== env.CODEX_THREAD_ID)) throw new Error('Use the current native thread ID');
  if (command === 'status') {
    const [state, receipt, config, connection, gateway] = await Promise.all([
      readState(directory, session), readReceipt(directory, session), loadGatewayConfig(directory).catch(() => null),
      connectionDiagnostic(directory, env, openClient), gatewayStatus(directory).catch(() => ({ running: false, reason: 'not_configured' })),
    ]);
    return { session, monitoringEnabled: state?.enabled === true, monitoringStoppedReason: state?.monitoringStoppedReason || null,
      initialRoute: state?.initialRoute || null, autoSwitch: state?.autoSwitch || null,
      switchRequest: state?.switchRequest || null, taskHalt: state?.taskHalt || null,
      configuration: config ? publicConfig(config) : null, connection,
      lastRequest: publicReceipt(receipt, state, config),
      routeEvidenceNote: 'A logged-in account and its quota display do not prove the request route. A failed lastRequest still proves gateway traversal, but not successful inference or backend model identity.',
      gateway };
  }
  if (command === 'disable') return withState(directory, session, state => {
    const now = Date.now();
    failAutoSwitch(state, now, 'autoswitch_disabled');
    stopMonitoring(state, now, 'autoswitch_disabled');
    if (state.autoSwitch) state.autoSwitch.enabled = false;
    return { autoSwitch: state.autoSwitch || null, switchRequest: state.switchRequest || null,
      monitoringEnabled: false, routeUnchanged: true, taskHalt: state.taskHalt || null };
  });
  if (command === 'use') {
    const state = await readState(directory, session);
    if (state?.autoSwitch?.protocol === 3 && state.autoSwitch.enabled && state.enabled) {
      return { session, monitoringEnabled: true, alreadyEnabled: true, autoSwitch: state.autoSwitch,
        switchRequest: state.switchRequest || null, taskHalt: state.taskHalt || null, switchApproved: false };
    }
    const current = state?.autoSwitch?.current || state?.initialRoute?.provider;
    if (current?.transport === 'official') return { session, monitoringEnabled: false, status: 'personal_route_unmonitored',
      provider: current.name, instruction: 'This thread selected the personal Official route. No automatic probes or route changes are needed.' };
    if (state?.autoSwitch) return { session, monitoringEnabled: state.enabled === true, status: 'existing_policy',
      autoSwitch: state.autoSwitch, taskHalt: state.taskHalt || null, switchRequest: state.switchRequest || null,
      instruction: 'Keep the saved route and any halt. Repeated natural-language use never re-arms a disabled policy or grants switch consent.' };
    const config = await loadGatewayConfig(directory);
    const deadline = Date.now() + 1000;
    let receipt;
    do {
      receipt = await readReceipt(directory, session);
      if (receipt?.configId === config.id && receipt.success && receipt.completed) break;
      await delay(25);
    } while (Date.now() < deadline);
    if (!receipt || receipt.configId !== config.id || !receipt.success || !receipt.completed) {
      const [connection, gateway] = await Promise.all([
        connectionDiagnostic(directory, env, openClient), gatewayStatus(directory).catch(() => ({ running: false, reason: 'unavailable' })),
      ]);
      const lastRequest = publicReceipt(receipt, state, config);
      if ((receipt && receipt.configId !== config.id) || (state?.initialRoute && state.initialRoute.configId !== config.id)) {
        return { session, monitoringEnabled: false, status: 'gateway_configuration_changed', connection, gateway, lastRequest, switchApproved: false,
          instruction: 'This thread has gateway evidence for an earlier configuration. Inspect the changed configuration and preserve its saved route; use does not migrate an existing thread or approve a switch.' };
      }
      if (receipt) return { session, monitoringEnabled: false, status: 'gateway_request_failed', connection, gateway, lastRequest, switchApproved: false,
        instruction: 'This thread already reached the gateway, but its latest request failed or did not complete successfully. Diagnose the reported request failure on the current route, then retry use after a successful primary response. A new conversation is not required merely because this request failed; no target verification or switch is approved.' };
      if (state?.initialRoute) return { session, monitoringEnabled: false, status: 'gateway_request_unconfirmed', connection, gateway, lastRequest, switchApproved: false,
        instruction: 'The gateway selected a route for this thread, but no completed request receipt is available yet. Inspect the in-flight request and gateway health; do not treat this as an old unconnected thread or enable monitoring without a successful primary response.' };
      if (connection.readyForNewThreads && (!gateway.running || gateway.readiness !== 'ready')) {
        return { session, monitoringEnabled: false, status: 'gateway_not_ready', connection, gateway, lastRequest, switchApproved: false,
          instruction: 'The ordinary entry is installed, but the gateway or its primary route is not ready. Resolve the reported gateway readiness condition first; a new conversation cannot repair an old daemon, changed default card, automatic failover, or unavailable service.' };
      }
      return { session, monitoringEnabled: false, status: connection.readyForNewThreads ? 'new_conversation_required' : 'connection_setup_required',
        connection, gateway, lastRequest, switchApproved: false,
        instruction: connection.readyForNewThreads
          ? 'The ordinary codex entry is configured, but this thread has no gateway route or request evidence. Existing running threads cannot be hot-attached. Start a fresh ordinary codex conversation after setup, then ask to use this plugin; do not claim this thread is monitored.'
          : 'Complete the one-time connect setup from the installed skill. It configures future ordinary codex conversations; no special launcher and no automatic monitoring. Check changed user/CCSwitch defaults before replacing anything.' };
    }
  }
  const { bank } = await loadArtifacts();
  const legacy = await readState(env.MODELTRACE_GUARD_DATA || path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'modeltrace-guard'), session);
  if (legacy?.enabled || legacy?.taskHalt) throw new Error('The upstream ModelTrace Guard still monitors or halts this thread; finish/stop that monitor before opting into this fork');
  const client = await openClient(env, { nativeOpenai: true });
  try {
    const [{ account }, settings] = await Promise.all([
      client.request('account/read', { refreshToken: false }), sourceSettings(client, session),
    ]);
    if (!bank.models.some(m => m.id === settings.model)) throw new Error('This exact model label is absent from the fingerprint bank; monitored switching is unavailable');
    await requireTrustedGuard(client, settings.cwd);
    const policy = await enableAutoSwitch(directory, session, { accountType: account?.type, modelProvider: settings.provider, model: settings.model });
    return command === 'use' ? { session, monitoringEnabled: true, status: 'monitoring_enabled', autoSwitch: policy, switchApproved: false } : policy;
  } finally { await client.close(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === entrypoint) {
  try { process.stdout.write(JSON.stringify(await runAutoSwitch(process.argv.slice(2))) + '\n'); }
  catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message,
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(Array.isArray(error.candidates) ? { candidates: error.candidates.map(({ id, name }) => ({ id, name })) } : {}),
    }) + '\n');
    process.exitCode = 1;
  }
}
