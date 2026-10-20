import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { atomicJSON, gatewayURL, loadGatewayConfig, runtimePath } from '../scripts/provider-config.mjs';
import { resolveSessionRoute, saveReceipt } from '../scripts/switch-policy.mjs';
import { runAutoSwitch } from '../scripts/autoswitch.mjs';
import { dataDirectory, readState, withState } from '../scripts/state.mjs';
import { isControlCommand, ROOT } from '../scripts/guard.mjs';

const execute = promisify(execFile);
const entry = path.join(ROOT, 'scripts', 'autoswitch.mjs');
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoswitch-cli-'));
  const env = { CODEX_HOME: path.join(directory, 'profile') };
  const invoke = (command, ...args) => runAutoSwitch([command, '--data-dir', directory, ...args], env);
  const sql = statement => execute('sqlite3', [path.join(directory, 'cc-switch.db'), statement]);
  t.after(async () => {
    await invoke('gateway-stop').catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await sql(`CREATE TABLE providers(id TEXT,name TEXT,category TEXT,app_type TEXT,settings_config TEXT,meta TEXT);
    INSERT INTO providers VALUES
      ('company','API2 copy',NULL,'codex','{"auth":{},"config":""}','{}'),
      ('other','Doro',NULL,'codex','{"auth":{},"config":""}','{}'),
      ('official','OpenAI Official','official','codex','{"auth":{},"config":""}','{}');
    CREATE TABLE proxy_config(app_type TEXT,listen_address TEXT,listen_port INTEGER,auto_failover_enabled INTEGER DEFAULT 0);
    INSERT INTO proxy_config(app_type,listen_address,listen_port) VALUES('codex','127.0.0.1',15721);`);
  await atomicJSON(path.join(directory, 'live-state.json'), { version: 1, apps: { codex: { mode: 'proxy', attached: true,
    proxy_route: 'company', stack: { enabled: true, members: ['company', 'other'], keys: { company: 'company', doro: 'other' } } } } });
  const configured = await invoke('configure', '--cc-switch-dir', directory, '--primary-name', 'API2 copy', '--backup-name', 'OpenAI Official', '--port', String(await freePort()));
  return { directory, env, invoke, sql, configured, config: await loadGatewayConfig(directory) };
}

async function nativeFixture(directory, { accountType = 'chatgpt', onAccountRead = async () => {}, configuration = null } = {}) {
  const definition = JSON.parse(await readFile(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  const hooks = Object.entries(definition.hooks).flatMap(([name, groups]) => groups.flatMap(group => group.hooks.map(handler => ({
    eventName: name[0].toLowerCase() + name.slice(1), ...handler, async: handler.async || false,
    enabled: true, trustStatus: 'trusted', pluginId: 'modeltrace-guard-autoswitch@fixture', handlerType: 'command', sourcePath: path.join(ROOT, 'hooks/hooks.json'),
  }))));
  const calls = [], children = [], closed = [], clientOptions = [];
  return { calls, children, closed, clientOptions, runtime: {
    executableFor: async () => '/fixture runtime/codex',
    openClient: async (_env, options) => {
      clientOptions.push(options);
      return {
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === 'account/read') { await onAccountRead(); return { account: { type: accountType } }; }
          if (method === 'thread/read') return { thread: { id: params.threadId, path: path.join(directory, 'fixture-rollout'), ephemeral: false,
            model: 'gpt-6-sol', modelProvider: 'openai', reasoningEffort: 'high', cwd: ROOT } };
          if (method === 'hooks/list') return { data: [{ hooks }] };
          if (method === 'config/read' && configuration) return configuration;
          throw new Error(`Unexpected native request: ${method}`);
        },
        close: async () => { closed.push(true); },
      };
    },
    spawnClient: (file, args, options) => {
      children.push({ file, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  } };
}

async function connectedNativeFixture(f) {
  await f.invoke('gateway-start');
  const profileFile = path.join(f.env.CODEX_HOME, 'config.toml');
  const owned = { model_provider: 'openai', openai_base_url: gatewayURL(f.config) };
  const name = { type: 'user', file: profileFile, profile: null };
  await atomicJSON(path.join(f.directory, 'native-integration.json'), { schema: 1, phase: 'installed', profileFile,
    configId: f.config.id, owned, original: { model_provider: { present: false }, openai_base_url: { present: false } },
    pending: null, lastWriteStatus: 'ok' });
  return nativeFixture(f.directory, { configuration: { config: owned,
    origins: Object.fromEntries(Object.keys(owned).map(key => [key, { name }])),
    layers: [{ name, version: 'fixture-version', config: owned, disabledReason: null }] } });
}

test('schema 2 gateway starts once, hides its capability, preserves company default and stops only its own instance', async t => {
  const f = await fixture(t), { invoke, config, configured } = f;
  assert.equal(configured.schema, 2);
  assert.equal(configured.primary.id, 'company'); assert.equal(configured.backup.id, 'official');
  assert.equal(configured.token, undefined);
  const original = (await f.sql('.dump')).stdout;
  const live = await readFile(path.join(f.directory, 'live-state.json'), 'utf8');
  const started = await invoke('gateway-start');
  assert.equal(started.running, true); assert.equal(started.readiness, 'ready');
  assert.equal((await invoke('gateway-start')).instanceId, started.instanceId);
  const status = await invoke('status', '--session', randomUUID());
  assert.equal(status.configuration.primary.name, 'API2 copy');
  assert.equal(status.configuration.backup.name, 'OpenAI Official');
  assert.equal(status.configuration.token, undefined);
  assert.ok(!JSON.stringify({ configured, started, status }).includes(config.token));
  await assert.rejects(invoke('configure', '--primary-provider', 'company', '--backup-provider', 'official'), /Stop this gateway/);
  assert.deepEqual(await invoke('gateway-stop'), { stopped: true });
  assert.equal((await invoke('gateway-status')).running, false);
  assert.equal((await f.sql('.dump')).stdout, original);
  assert.equal(await readFile(path.join(f.directory, 'live-state.json'), 'utf8'), live);
  await atomicJSON(runtimePath(f.directory), { pid: process.pid, instanceId: randomUUID(), configId: config.id });
  assert.equal((await invoke('gateway-stop')).stopped, false);
});

test('an old running gateway cannot be reported ready after installing a newer implementation', async t => {
  const f = await fixture(t), instanceId = randomUUID();
  const server = createHttpServer((req, res) => {
    if (req.url.endsWith('/shutdown')) res.once('finish', () => { server.close(); server.closeAllConnections(); });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, instanceId })); // v0.4.0 has no implementation marker.
  });
  await new Promise(resolve => server.listen(f.config.port, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await atomicJSON(runtimePath(f.directory), { pid: process.pid, instanceId, configId: f.config.id });
  const status = await f.invoke('gateway-status');
  assert.equal(status.running, true);
  assert.equal(status.readiness, 'upgrade_required');
  assert.equal(status.implementationVersion, null);
  await assert.rejects(f.invoke('gateway-start'), /upgrade required/);
  assert.equal((await f.invoke('gateway-stop')).stopped, true);
  assert.equal((await f.invoke('gateway-start')).readiness, 'ready');
});

test('a changed primary reports gateway readiness instead of telling connected users to start another conversation', async t => {
  const f = await fixture(t), native = await connectedNativeFixture(f);
  await f.sql("UPDATE proxy_config SET auto_failover_enabled=1 WHERE app_type='codex'");
  const result = await runAutoSwitch(['use', '--session', randomUUID(), '--data-dir', f.directory], f.env, native.runtime);
  assert.equal(result.status, 'gateway_not_ready');
  assert.match(result.gateway.readiness, /automatic failover/);
  assert.equal(result.monitoringEnabled, false); assert.equal(result.switchApproved, false);
  await f.invoke('gateway-stop');
  const restarted = await f.invoke('gateway-start');
  assert.equal(restarted.running, true, 'transport can restart for already selected Official threads');
  assert.match(restarted.readiness, /automatic failover/);
});

test('configuration accepts complete names or IDs and rejects mixed or incomplete selectors before mutation', async t => {
  const f = await fixture(t);
  for (const args of [
    ['--primary-name', 'API2 copy'],
    ['--primary-name', 'API2 copy', '--backup-provider', 'official'],
    ['--primary-name', 'API2 copy', '--backup-name', 'Doro', '--primary-provider', 'company'],
    ['--primary-provider', 'company'],
    ['--primary-name', '', '--backup-name', 'Doro'],
  ]) {
    await assert.rejects(f.invoke('configure', ...args), /both|mix|Invalid/);
    assert.deepEqual(await loadGatewayConfig(f.directory), f.config);
  }
  const byId = await f.invoke('configure', '--cc-switch-dir', f.directory, '--primary-provider', 'company', '--backup-provider', 'other', '--port', String(f.config.port));
  assert.equal(byId.primary.id, 'company'); assert.equal(byId.backup.id, 'other');
  const byCase = await f.invoke('configure', '--cc-switch-dir', f.directory, '--primary-name', 'api2 COPY', '--backup-name', 'doro', '--port', String(f.config.port));
  assert.equal(byCase.primary.id, 'company'); assert.equal(byCase.backup.id, 'other');
});

test('ambiguous names retain structured candidate IDs in CLI errors without exposing the capability', async t => {
  const f = await fixture(t);
  await f.sql(`INSERT INTO providers VALUES('company-2','API2 copy',NULL,'codex','{"auth":{},"config":""}','{}');`);
  const args = ['configure', '--data-dir', f.directory, '--cc-switch-dir', f.directory, '--primary-name', 'API2 copy', '--backup-name', 'OpenAI Official'];
  await assert.rejects(runAutoSwitch(args, f.env), error => {
    assert.equal(error.code, 'AMBIGUOUS_PROVIDER');
    assert.deepEqual(error.candidates.map(item => item.id), ['company', 'company-2']);
    return true;
  });
  await assert.rejects(execute(process.execPath, [entry, ...args]), error => {
    const result = JSON.parse(error.stderr.trim());
    assert.equal(result.code, 'AMBIGUOUS_PROVIDER');
    assert.deepEqual(result.candidates.map(item => item.id), ['company', 'company-2']);
    assert.ok(!error.stderr.includes(f.config.token));
    return true;
  });
});

test('launch defaults to primary and passes explicit valid Stack or Official choices as argv without enabling monitoring', async t => {
  const f = await fixture(t), native = await nativeFixture(f.directory), session = randomUUID();
  const launch = (...args) => runAutoSwitch(['launch', '--data-dir', f.directory, ...args], f.env, native.runtime);
  for (const args of [[], ['--provider-name', 'Doro'], ['--provider-id', 'official', '--resume', session]]) assert.deepEqual(await launch(...args), { exited: true, code: 0 });
  const urls = native.children.map(child => JSON.parse(child.args[3].slice('openai_base_url='.length)));
  assert.deepEqual(urls, [gatewayURL(f.config), gatewayURL(f.config, 'other'), gatewayURL(f.config, 'official')]);
  assert.deepEqual(native.children[2].args.slice(-2), ['resume', session]);
  assert.equal(native.children[0].args[1], 'model_provider="openai"');
  assert.equal(native.children[0].file, '/fixture runtime/codex');
  assert.equal(native.children[0].options.env.MODELTRACE_AUTOSWITCH_DATA, f.directory);
  assert.equal(native.closed.length, 3);
  assert.ok(native.calls.every(call => call.method === 'account/read'));
  assert.equal(await readState(f.directory, session), null);
  await assert.rejects(launch('--provider-name', 'Doro', '--provider-id', 'other'), /not both/);
  await assert.rejects(launch('--provider-name', 'missing'), error => error.code === 'PROVIDER_NOT_FOUND');
  assert.equal(native.children.length, 3);
});

test('launch rejects non-native authentication and provider changes before spawning the client', async t => {
  const f = await fixture(t), apiKey = await nativeFixture(f.directory, { accountType: 'apiKey' });
  await assert.rejects(runAutoSwitch(['launch', '--data-dir', f.directory], f.env, apiKey.runtime), /ChatGPT/);
  assert.equal(apiKey.children.length, 0); assert.equal(apiKey.closed.length, 1);
  assert.equal((await f.invoke('gateway-status')).running, false);
  const drift = await nativeFixture(f.directory, { onAccountRead: () => f.sql(`UPDATE providers SET settings_config='{"auth":{"OPENAI_API_KEY":"fixture-change"},"config":""}' WHERE id='other';`) });
  await assert.rejects(runAutoSwitch(['launch', '--data-dir', f.directory, '--provider-name', 'Doro'], f.env, drift.runtime), /configuration changed/);
  assert.equal(drift.children.length, 0);
});

test('launch and enable request native OpenAI mode for both authentication checks', async t => {
  const f = await fixture(t), native = await nativeFixture(f.directory);
  await runAutoSwitch(['launch', '--data-dir', f.directory], f.env, native.runtime);
  await assert.rejects(runAutoSwitch(['enable', '--data-dir', f.directory, '--session', randomUUID()], f.env, native.runtime), /primary/i);
  assert.deepEqual(native.clientOptions, [{ nativeOpenai: true }, { nativeOpenai: true }]);
  assert.equal(native.calls.filter(call => call.method === 'account/read').length, 2);
});

test('enable cannot move an explicitly selected Official thread to the primary or start probes without a primary receipt', async t => {
  const f = await fixture(t), session = randomUUID(), native = await nativeFixture(f.directory);
  const route = await resolveSessionRoute(f.directory, f.config, session, 'official');
  assert.equal(route.transport, 'official');
  const before = await readState(f.directory, session);
  await assert.rejects(runAutoSwitch(['enable', '--data-dir', f.directory, '--session', session], f.env, native.runtime), /primary/i);
  assert.deepEqual(await readState(f.directory, session), before);
  assert.ok(native.calls.every(call => ['account/read', 'thread/read', 'hooks/list'].includes(call.method)));
  assert.equal(native.children.length, 0);
  assert.equal((await resolveSessionRoute(f.directory, f.config, session)).transport, 'official');
});

test('enable monitors a verified primary thread without selecting another route or approving a switch', async t => {
  const f = await fixture(t), session = randomUUID(), native = await nativeFixture(f.directory);
  const route = await resolveSessionRoute(f.directory, f.config, session);
  assert.equal(route.providerId, 'company');
  const initialRoute = (await readState(f.directory, session)).initialRoute;
  // Isolated fixture receipt: this test never calls a provider or generates a model turn.
  await saveReceipt(f.directory, f.config, { ...route, threadId: session, requestId: randomUUID(), statusCode: 200,
    startedAt: Date.now() - 20, finishedAt: Date.now() - 10, success: true, completed: true, responseEvent: 'response.completed' });
  const enabled = await runAutoSwitch(['enable', '--data-dir', f.directory, '--session', session], f.env, native.runtime);
  assert.equal(enabled.current.id, 'company'); assert.equal(enabled.phase, 'armed');
  assert.equal(enabled.approvalMode, 'per_incident'); assert.equal(enabled.attempts, 0);
  const state = await readState(f.directory, session);
  assert.equal(state.enabled, true); assert.deepEqual(state.initialRoute, initialRoute);
  assert.equal(state.switchRequest ?? null, null);
  assert.equal((await resolveSessionRoute(f.directory, f.config, session)).providerId, 'company');
  assert.ok(native.calls.every(call => ['account/read', 'thread/read', 'hooks/list'].includes(call.method)));
  assert.equal(native.children.length, 0);
});

test('disable stops monitoring but retains the chosen route and halt; only exact management commands bypass the guard', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoswitch-disable-')), session = randomUUID(), request = randomUUID();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await withState(directory, session, s => {
    s.enabled = true;
    s.autoSwitch = { protocol: 3, approvalMode: 'per_incident', enabled: true, phase: 'awaiting_approval', route: 'source' };
    s.switchRequest = { id: request, status: 'pending' }; s.taskHalt = { id: 'new-halt' };
  });
  const disabled = await runAutoSwitch(['disable', '--data-dir', directory, '--session', session], {});
  assert.equal(disabled.autoSwitch.enabled, false); assert.equal(disabled.autoSwitch.route, 'source');
  assert.equal(disabled.switchRequest.id, request); assert.equal(disabled.switchRequest.status, 'failed');
  assert.equal(disabled.taskHalt.id, 'new-halt'); assert.equal((await readState(directory, session)).enabled, false);
  assert.equal(disabled.monitoringEnabled, false);
  const status = await runAutoSwitch(['status', '--data-dir', directory, '--session', session], {});
  assert.equal(status.monitoringEnabled, false); assert.equal(status.monitoringStoppedReason, 'autoswitch_disabled');
  assert.equal(status.switchRequest.id, request); assert.equal(status.switchRequest.reason, 'autoswitch_disabled');
  assert.equal(status.configuration, null);
  const allowed = cmd => isControlCommand({ tool_name: 'Bash', tool_input: { command: cmd } });
  assert.equal(allowed(`node '${entry}' disable --session ${session}`), true);
  assert.equal(allowed(`node '${entry}' status --session ${session}`), true);
  assert.equal(allowed(`node '${entry}' gateway-stop`), true);
  for (const suffix of [' launch', ' configure', ' status --unexpected x', ' status; echo bypass', ' status --session x --session y']) assert.equal(allowed(`node '${entry}'${suffix}`), false);
});

test('new fork storage is isolated per Codex home and ignores the upstream storage override', () => {
  assert.equal(dataDirectory(undefined, { CODEX_HOME: '/profiles/personal', MODELTRACE_GUARD_DATA: '/old' }), path.resolve('/profiles/personal/modeltrace-guard-autoswitch'));
  assert.equal(dataDirectory(undefined, { MODELTRACE_AUTOSWITCH_DATA: '/explicit-new', MODELTRACE_GUARD_DATA: '/old' }), path.resolve('/explicit-new'));
});

test('natural-language use enables only the already-connected primary thread and is idempotent', async t => {
  const f = await fixture(t), session = randomUUID(), native = await nativeFixture(f.directory);
  const route = await resolveSessionRoute(f.directory, f.config, session);
  await saveReceipt(f.directory, f.config, { ...route, threadId: session, requestId: randomUUID(), statusCode: 200,
    startedAt: Date.now() - 20, finishedAt: Date.now() - 10, success: true, completed: true, responseEvent: 'response.completed' });
  const invoke = () => runAutoSwitch(['use', '--session', session, '--data-dir', f.directory], f.env, native.runtime);
  const first = await invoke();
  assert.equal(first.status, 'monitoring_enabled'); assert.equal(first.monitoringEnabled, true); assert.equal(first.switchApproved, false);
  const before = await readState(f.directory, session), nativeCount = native.calls.length;
  const second = await invoke();
  assert.equal(second.alreadyEnabled, true); assert.equal(native.calls.length, nativeCount);
  assert.deepEqual(await readState(f.directory, session), before);
  assert.equal(native.children.length, 0, 'ordinary use never starts a replacement CLI');
});

test('natural-language use leaves personal routes unmonitored without inspecting credentials or moving them', async t => {
  const f = await fixture(t), session = randomUUID(), native = await nativeFixture(f.directory);
  await resolveSessionRoute(f.directory, f.config, session, 'official');
  const before = await readState(f.directory, session);
  const result = await runAutoSwitch(['use', '--session', session, '--data-dir', f.directory], f.env, native.runtime);
  assert.equal(result.status, 'personal_route_unmonitored'); assert.equal(result.monitoringEnabled, false);
  assert.deepEqual(await readState(f.directory, session), before); assert.equal(native.calls.length, 0); assert.equal(native.children.length, 0);
});

test('ordinary unconnected conversations are not falsely reported as monitored or automatically relaunched', async t => {
  const f = await fixture(t), session = randomUUID(), native = await nativeFixture(f.directory);
  const result = await runAutoSwitch(['use', '--session', session, '--data-dir', f.directory], f.env, native.runtime);
  assert.equal(result.status, 'connection_setup_required'); assert.equal(result.monitoringEnabled, false);
  assert.equal(result.connection.phase, 'not_installed'); assert.equal(result.switchApproved, false);
  assert.equal(native.calls.length, 0); assert.equal(native.children.length, 0);
  assert.equal(await readState(f.directory, session), null);
});

test('use distinguishes a connected HTTP failure from an old conversation and preserves actionable safe diagnostics', async t => {
  const f = await fixture(t), session = randomUUID(), native = await connectedNativeFixture(f);
  const route = await resolveSessionRoute(f.directory, f.config, session);
  await saveReceipt(f.directory, f.config, { ...route, threadId: session, requestId: randomUUID(), statusCode: 403,
    startedAt: Date.now() - 20, finishedAt: Date.now() - 10, success: false, completed: true, responseEvent: 'response.failed',
    error: `Bearer private-upstream-token ${gatewayURL(f.config)}` });
  const before = await readState(f.directory, session);
  const result = await runAutoSwitch(['use', '--session', session, '--data-dir', f.directory], f.env, native.runtime);
  assert.equal(result.connection.readyForNewThreads, true);
  assert.equal(result.status, 'gateway_request_failed'); assert.equal(result.monitoringEnabled, false);
  assert.equal(result.switchApproved, false); assert.equal(result.lastRequest.provider, 'API2 copy');
  assert.equal(result.lastRequest.statusCode, 403); assert.equal(result.lastRequest.responseEvent, 'response.failed');
  assert.equal(result.lastRequest.failureReason, 'upstream_forbidden');
  assert.match(result.lastRequest.failureHint, /header\/transport compatibility/);
  assert.match(result.instruction, /already reached the gateway/);
  assert.equal(result.lastRequest.configurationMatches, true);
  const status = await runAutoSwitch(['status', '--session', session, '--data-dir', f.directory], f.env, native.runtime);
  assert.deepEqual(status.lastRequest, result.lastRequest);
  assert.deepEqual(await readState(f.directory, session), before);
  assert.ok(native.calls.every(call => call.method === 'config/read'), 'failure diagnosis must not inspect accounts, infer or write configuration');
  assert.equal(native.children.length, 0);
  assert.ok(!JSON.stringify({ result, status }).includes(f.config.token));
  assert.ok(!JSON.stringify({ result, status }).includes('private-upstream-token'));
});

test('use keeps HTTP success with failed or interrupted generation distinct from successful monitoring readiness', async t => {
  const f = await fixture(t), native = await nativeFixture(f.directory);
  for (const outcome of [
    { completed: true, responseEvent: 'response.failed', failureReason: 'upstream_response_failed' },
    { completed: false, responseEvent: null, failureReason: 'gateway_response_interrupted' },
    { completed: true, responseEvent: null, failureReason: 'response_completion_unconfirmed' },
  ]) {
    const session = randomUUID(), route = await resolveSessionRoute(f.directory, f.config, session);
    await saveReceipt(f.directory, f.config, { ...route, threadId: session, requestId: randomUUID(), statusCode: 200,
      startedAt: Date.now() - 20, finishedAt: Date.now() - 10, success: false, ...outcome });
    const result = await runAutoSwitch(['use', '--session', session, '--data-dir', f.directory], f.env, native.runtime);
    assert.equal(result.status, 'gateway_request_failed'); assert.equal(result.monitoringEnabled, false);
    assert.equal(result.lastRequest.statusCode, 200); assert.equal(result.lastRequest.responseEvent, outcome.responseEvent);
    assert.equal(result.lastRequest.failureReason, outcome.failureReason);
    assert.equal((await readState(f.directory, session)).autoSwitch ?? null, null);
  }
  assert.equal(native.calls.length, 0); assert.equal(native.children.length, 0);
});

test('status exposes bounded failure diagnostics without echoing an arbitrary upstream event or error body', async t => {
  const f = await fixture(t), session = randomUUID(), native = await nativeFixture(f.directory);
  const route = await resolveSessionRoute(f.directory, f.config, session);
  for (const [statusCode, responseEvent, reason] of [
    [401, 'error', 'upstream_authentication_failed'],
    [429, 'error', 'upstream_rate_limited'],
    [504, null, 'gateway_request_timeout'],
    [502, 'upstream-private-token', 'gateway_http_failure'],
    [200, 'response.error', 'upstream_response_failed'],
  ]) {
    await saveReceipt(f.directory, f.config, { ...route, threadId: session, requestId: randomUUID(), statusCode,
      startedAt: Date.now() - 20, finishedAt: Date.now() - 10, success: false, completed: true, responseEvent });
    const result = await runAutoSwitch(['status', '--session', session, '--data-dir', f.directory], f.env, native.runtime);
    assert.equal(result.lastRequest.statusCode, statusCode); assert.equal(result.lastRequest.failureReason, reason);
    assert.equal(result.lastRequest.responseEvent, responseEvent === 'upstream-private-token' ? null : responseEvent);
    assert.ok(!JSON.stringify(result).includes('upstream-private-token'));
    assert.ok(!JSON.stringify(result).includes(f.config.token));
  }
  assert.equal(native.calls.length, 0); assert.equal(native.children.length, 0);
});

test('only a thread without gateway evidence gets the new-conversation handoff after ordinary setup', async t => {
  const f = await fixture(t), session = randomUUID(), native = await connectedNativeFixture(f);
  const result = await runAutoSwitch(['use', '--session', session, '--data-dir', f.directory], f.env, native.runtime);
  assert.equal(result.status, 'new_conversation_required'); assert.equal(result.connection.readyForNewThreads, true);
  assert.equal(result.lastRequest, null); assert.equal(result.monitoringEnabled, false);
  assert.equal(await readState(f.directory, session), null);
  assert.ok(native.calls.every(call => call.method === 'config/read')); assert.equal(native.children.length, 0);
});

test('an initial gateway route without a finished receipt is unconfirmed rather than unconnected', async t => {
  const f = await fixture(t), session = randomUUID(), native = await connectedNativeFixture(f);
  await resolveSessionRoute(f.directory, f.config, session);
  const before = await readState(f.directory, session);
  const result = await runAutoSwitch(['use', '--session', session, '--data-dir', f.directory], f.env, native.runtime);
  assert.equal(result.status, 'gateway_request_unconfirmed'); assert.equal(result.lastRequest, null);
  assert.equal(result.monitoringEnabled, false); assert.equal(result.switchApproved, false);
  assert.deepEqual(await readState(f.directory, session), before);
});

test('use reports stale gateway evidence without implicitly migrating or enabling the thread', async t => {
  const f = await fixture(t), session = randomUUID(), native = await connectedNativeFixture(f);
  const route = await resolveSessionRoute(f.directory, f.config, session);
  await saveReceipt(f.directory, { ...f.config, id: randomUUID() }, { ...route, threadId: session, requestId: randomUUID(), statusCode: 200,
    startedAt: Date.now() - 20, finishedAt: Date.now() - 10, success: true, completed: true, responseEvent: 'response.completed' });
  const before = await readState(f.directory, session);
  const result = await runAutoSwitch(['use', '--session', session, '--data-dir', f.directory], f.env, native.runtime);
  assert.equal(result.status, 'gateway_configuration_changed'); assert.equal(result.lastRequest.configurationMatches, false);
  assert.equal(result.monitoringEnabled, false); assert.equal(result.switchApproved, false);
  assert.deepEqual(await readState(f.directory, session), before);
});

test('ordinary entry rejects a command-only data directory before native configuration or gateway mutation', async t => {
  const f = await fixture(t), native = await nativeFixture(f.directory);
  await assert.rejects(runAutoSwitch(['connect', '--data-dir', f.directory], f.env, native.runtime), /same data directory/);
  assert.equal(native.calls.length, 0); assert.equal(native.children.length, 0);
  assert.equal((await f.invoke('gateway-status')).running, false);
});

test('the real connect CLI returns its startup trust requirement without a circular-import deadlock', { timeout: 10000 }, async t => {
  const f = await fixture(t), executable = path.join(f.directory, 'fake-native.mjs');
  await writeFile(executable, `#!${process.execPath}\nimport readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
 const request=JSON.parse(line); if(request.id===undefined)continue;
 const result=request.method==='account/read'?{account:{type:'chatgpt'}}:request.method==='hooks/list'?{data:[]}:{};
 process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
}\n`, { mode: 0o700 });
  await assert.rejects(execute(process.execPath, [entry, 'connect'], {
    env: { ...process.env, ...f.env, MODELTRACE_AUTOSWITCH_DATA: f.directory, MODELTRACE_CODEX_PATH: executable }, timeout: 5000,
  }), error => {
    assert.equal(error.killed, false, 'connect must finish rather than wait for a cyclic top-level import');
    assert.match(error.stderr, /Review the updated synchronous ModelTrace startup hook/);
    return true;
  });
  assert.equal((await f.invoke('gateway-status')).running, false);
});
