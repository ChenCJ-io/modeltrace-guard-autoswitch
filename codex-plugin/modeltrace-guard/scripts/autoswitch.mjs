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
import { startSwitchGateway } from './switch-gateway.mjs';
import { installNativeIntegration, nativeIntegrationStatus, removeNativeIntegration } from './native-integration.mjs';
import {
  UUID, atomicJSON, assertProviderCurrent, configureGateway, gatewayURL, inspectCCSwitch,
  loadGatewayConfig, publicConfig, readJSON, resolveProvider, runtimePath, verifyGatewayReady,
} from './provider-config.mjs';
import {
  enableAutoSwitch, failAutoSwitch, readReceipt, resolveSessionRoute, saveReceipt,
} from './switch-policy.mjs';

const entrypoint = fileURLToPath(import.meta.url);
function argumentsFor(args) {
  const command = args.shift() || 'help', options = {};
  const allowed = {
    help: [], inspect: ['cc-switch-dir'], configure: ['primary-name', 'backup-name', 'primary-provider', 'backup-provider', 'cc-switch-dir', 'port'],
    connect: [], disconnect: [], 'connection-status': [],
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
    let readiness = 'ready';
    try { await verifyGatewayReady(directory, config); } catch (error) { readiness = error.message; }
    return { running: true, readiness, pid: runtime.pid, instanceId: runtime.instanceId, port: config.port, configId: config.id };
  } catch { return { running: false, reason: 'gateway_unreachable', port: config.port }; }
}

export async function startGateway(directory) {
  const current = await gatewayStatus(directory);
  if (current.running) return current;
  const config = await loadGatewayConfig(directory);
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
  const config = await loadGatewayConfig(directory), instanceId = randomUUID();
  await verifyGatewayReady(directory, config);
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const gateway = await startSwitchGateway({ upstream: config.upstream, port: config.port, token: config.token, instanceId,
    verifyReady: () => verifyGatewayReady(directory, config),
    resolveRoute: (thread, initialProviderId) => resolveSessionRoute(directory, config, thread, initialProviderId),
    onReceipt: receipt => saveReceipt(directory, config, receipt),
    onShutdown: () => resolveDone(),
  });
  await atomicJSON(runtimePath(directory), { instanceId, configId: config.id, pid: process.pid, port: config.port, startedAt: Date.now() });
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

export async function runAutoSwitch(args, env = process.env, {
  openClient = openAppServer, executableFor = codexExecutable, spawnClient = spawn,
} = {}) {
  const { command, options } = argumentsFor([...args]);
  const directory = dataDirectory(options['data-dir'], env);
  if (command === 'help') return { commands: ['inspect', 'configure', 'connect', 'disconnect', 'connection-status', 'use', 'gateway-start', 'gateway-stop', 'gateway-status', 'launch', 'enable', 'disable', 'status'],
    use: 'Natural-language entry: use enables monitoring only for this already-connected thread; it never launches another CLI or approves a switch.',
    connect: 'One-time setup for ordinary codex: connect this Codex home\'s future new conversations to the gateway. Existing running threads are unchanged; monitoring remains off.',
    disconnect: 'Restore only the two defaults still owned by this plugin. Existing gateway conversations and monitoring are unchanged; the gateway stays running.',
    configure: 'configure --primary-name NAME --backup-name NAME (or --primary-provider ID --backup-provider ID) [--cc-switch-dir PATH] [--port 15722]',
    launch: 'launch [--resume THREAD_ID] [--provider-name NAME | --provider-id ID] (default: primary; no global config edits)',
    enable: 'enable [--session THREAD_ID] (monitor an already successful primary-route thread; never changes its route)',
    disable: 'Stop monitoring and cancel a pending switch request; keep the selected route and any halt',
    incidents: 'Use guard.mjs propose-switch / approve-switch / decline-switch / wait-switch for an incident request',
    scope: 'Pause on the first valid fingerprint mismatch. Each target verification and switch requires consent for that incident. Configuration, enable and acknowledgement never approve a switch.', dataDirectory: directory };
  if (command === 'inspect') return inspectCCSwitch(options['cc-switch-dir']);
  if (command === 'connection-status') return nativeIntegrationStatus(directory, env, { connect: openClient });
  if (command === 'disconnect') return removeNativeIntegration(directory, env, { connect: openClient });
  if (command === 'connect') {
    if (directory !== dataDirectory(undefined, env)) {
      throw new Error('Ordinary codex startup must discover the same data directory. Use this Codex home default or the same MODELTRACE_AUTOSWITCH_DATA environment for both setup and ordinary codex; a command-only --data-dir cannot be connected');
    }
    const config = await loadGatewayConfig(directory);
    const layout = await verifyGatewayReady(directory, config);
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
    const state = await readState(directory, session);
    const receipt = await readReceipt(directory, session);
    const identities = [state?.autoSwitch?.current, state?.autoSwitch?.primary, state?.autoSwitch?.backup, state?.initialRoute?.provider];
    const observedProvider = receipt && identities.find(provider => provider?.id === receipt.providerId);
    return { session, monitoringEnabled: state?.enabled === true, monitoringStoppedReason: state?.monitoringStoppedReason || null,
      initialRoute: state?.initialRoute || null, autoSwitch: state?.autoSwitch || null,
      switchRequest: state?.switchRequest || null, taskHalt: state?.taskHalt || null,
      configuration: await loadGatewayConfig(directory).then(publicConfig).catch(() => null),
      connection: await nativeIntegrationStatus(directory, env, { connect: openClient }).catch(() => ({ readyForNewThreads: false, phase: 'unavailable' })),
      lastRequest: receipt ? { provider: observedProvider?.name || receipt.providerId, transport: receipt.transport,
        completed: receipt.completed, success: receipt.success, finishedAt: receipt.finishedAt,
        scope: 'most_recent_gateway_request_only' } : null,
      routeEvidenceNote: 'A logged-in account and its quota display do not prove the request route. lastRequest is local gateway evidence, not backend model identity.',
      gateway: await gatewayStatus(directory).catch(() => ({ running: false, reason: 'not_configured' })) };
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
      const connection = await nativeIntegrationStatus(directory, env, { connect: openClient });
      return { session, monitoringEnabled: false, status: connection.readyForNewThreads ? 'new_conversation_required' : 'connection_setup_required',
        connection, switchApproved: false,
        instruction: connection.readyForNewThreads
          ? 'The ordinary codex entry is configured, but this thread has no successful gateway request. Existing running threads cannot be hot-attached. Start a fresh ordinary codex conversation after setup, then ask to use this plugin; do not claim this thread is monitored.'
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
