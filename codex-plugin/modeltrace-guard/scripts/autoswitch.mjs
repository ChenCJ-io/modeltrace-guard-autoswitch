#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { dataDirectory, readState, withState, abandon } from './state.mjs';
import { openAppServer, codexExecutable } from './app-server-client.mjs';
import { sourceSettings } from './fork-snapshot.mjs';
import { requireTrustedGuard } from './fork-runner.mjs';
import { loadArtifacts } from './guard.mjs';
import { startSwitchGateway } from './switch-gateway.mjs';
import {
  UUID, atomicJSON, configureGateway, enableAutoSwitch, failAutoSwitch, gatewayURL, inspectCCSwitch,
  loadGatewayConfig, readJSON, resolveSessionRoute, runtimePath, saveReceipt, verifyGatewayReady,
} from './switch-policy.mjs';

const entrypoint = fileURLToPath(import.meta.url);
function argumentsFor(args) {
  const command = args.shift() || 'help', options = {};
  const allowed = {
    help: [], inspect: ['cc-switch-dir'], configure: ['source-provider', 'fallback-provider', 'cc-switch-dir', 'port'],
    'gateway-start': [], 'gateway-stop': [], 'gateway-status': [], serve: [], enable: ['session'], disable: ['session'], status: ['session'], launch: ['resume'],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown command');
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith('--') || !args.length || Object.hasOwn(options, flag.slice(2)) || !['data-dir', ...allowed[command]].includes(flag.slice(2))) throw new Error(`Invalid option ${flag}`);
    options[flag.slice(2)] = args.shift();
  }
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
    resolveRoute: thread => resolveSessionRoute(directory, config, thread),
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

export async function runAutoSwitch(args, env = process.env) {
  const { command, options } = argumentsFor([...args]);
  const directory = dataDirectory(options['data-dir'], env);
  if (command === 'help') return { commands: ['inspect', 'configure', 'gateway-start', 'gateway-stop', 'gateway-status', 'launch', 'enable', 'disable', 'status'],
    configure: 'configure --source-provider ID --fallback-provider ID [--cc-switch-dir PATH] [--port 15722]',
    launch: 'launch [--resume THREAD_ID] (interactive native Codex; no global config edits)',
    enable: 'enable [--session THREAD_ID] (after one successful request through the gateway, using native ChatGPT login)',
    scope: 'Per thread, one authorized API provider → official fallback. No automatic switch-back.', dataDirectory: directory };
  if (command === 'inspect') return inspectCCSwitch(options['cc-switch-dir']);
  if (command === 'configure') {
    const current = await gatewayStatus(directory).catch(() => ({ running: false }));
    if (current.running) throw new Error('Stop this gateway before reconfiguring it');
    return configureGateway(directory, { sourceProvider: options['source-provider'], fallbackProvider: options['fallback-provider'],
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
    await startGateway(directory);
    const config = await loadGatewayConfig(directory);
    const executable = await codexExecutable(env);
    const client = await openAppServer(env);
    try {
      const { account } = await client.request('account/read', { refreshToken: false });
      if (account?.type !== 'chatgpt') throw new Error('Sign into the native Codex client with ChatGPT before launch');
    } finally { await client.close(); }
    // argv is passed directly; never build a shell command or persist the URL
    // to the user's shared Codex or CCSwitch configuration.
    const child = spawn(executable, ['-c', 'model_provider="openai"', '-c', `openai_base_url=${JSON.stringify(gatewayURL(config))}`,
      ...(options.resume ? ['resume', options.resume] : [])], { stdio: 'inherit', env: { ...env, MODELTRACE_AUTOSWITCH_DATA: directory } });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    return { exited: true, code };
  }
  const session = options.session || env.CODEX_THREAD_ID;
  if (!UUID.test(session || '') || (env.CODEX_THREAD_ID && session !== env.CODEX_THREAD_ID)) throw new Error('Use the current native thread ID');
  if (command === 'status') {
    const state = await readState(directory, session);
    return { session, autoSwitch: state?.autoSwitch || null, taskHalt: state?.taskHalt || null,
      gateway: await gatewayStatus(directory).catch(() => ({ running: false, reason: 'not_configured' })) };
  }
  if (command === 'disable') return withState(directory, session, state => {
    failAutoSwitch(state, Date.now(), 'autoswitch_disabled');
    if (state.pending?.kind === 'fallback_verification') abandon(state, Date.now(), 'autoswitch_disabled');
    if (state.autoSwitch) state.autoSwitch.enabled = false;
    return { autoSwitch: state.autoSwitch || null, routeUnchanged: true, taskHalt: state.taskHalt || null };
  });
  const { bank } = await loadArtifacts();
  const legacy = await readState(env.MODELTRACE_GUARD_DATA || path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'modeltrace-guard'), session);
  if (legacy?.enabled || legacy?.taskHalt) throw new Error('The upstream ModelTrace Guard still monitors or halts this thread; finish/stop that monitor before opting into this fork');
  const client = await openAppServer(env);
  try {
    const [{ account }, settings] = await Promise.all([
      client.request('account/read', { refreshToken: false }), sourceSettings(client, session),
    ]);
    if (!bank.models.some(m => m.id === settings.model)) throw new Error('This exact model label is absent from the fingerprint bank; automatic switching is unavailable');
    await requireTrustedGuard(client, settings.cwd);
    return enableAutoSwitch(directory, session, { accountType: account?.type, modelProvider: settings.provider, model: settings.model });
  } finally { await client.close(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === entrypoint) {
  try { process.stdout.write(JSON.stringify(await runAutoSwitch(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; }
}
