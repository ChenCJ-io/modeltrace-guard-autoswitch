import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { atomicJSON, loadGatewayConfig, runtimePath } from '../scripts/switch-policy.mjs';
import { runAutoSwitch } from '../scripts/autoswitch.mjs';
import { dataDirectory, readState, withState } from '../scripts/state.mjs';
import { isControlCommand, ROOT } from '../scripts/guard.mjs';

const execute = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('real gateway CLI process starts once, reports metadata only, and shuts down its own instance', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoswitch-cli-'));
  const invoke = (command, ...args) => runAutoSwitch([command, '--data-dir', directory, ...args], {});
  t.after(async () => {
    await invoke('gateway-stop').catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await execute('sqlite3', [path.join(directory, 'cc-switch.db'), `CREATE TABLE providers(id TEXT,name TEXT,category TEXT,app_type TEXT,settings_config TEXT,meta TEXT);
    INSERT INTO providers VALUES('company','Company',NULL,'codex','{"auth":{},"config":""}','{}'),('official','Official','official','codex','{"auth":{},"config":""}','{}');
    CREATE TABLE proxy_config(app_type TEXT,listen_address TEXT,listen_port INTEGER);
    INSERT INTO proxy_config VALUES('codex','127.0.0.1',15721);`]);
  await atomicJSON(path.join(directory, 'live-state.json'), { version: 1, apps: { codex: { mode: 'proxy', attached: true,
    proxy_route: 'official', stack: { enabled: true, members: ['company'], keys: { company: 'company' } } } } });
  const configured = await invoke('configure', '--cc-switch-dir', directory, '--source-provider', 'company', '--fallback-provider', 'official', '--port', String(await freePort()));
  const config = await loadGatewayConfig(directory);
  assert.equal(configured.token, undefined);
  const started = await invoke('gateway-start');
  assert.equal(started.running, true); assert.equal(started.readiness, 'ready');
  assert.equal((await invoke('gateway-start')).instanceId, started.instanceId);
  assert.ok(!JSON.stringify(started).includes(config.token));
  await assert.rejects(invoke('configure', '--source-provider', 'company', '--fallback-provider', 'official'), /Stop this gateway/);
  const original = await execute('sqlite3', [path.join(directory, 'cc-switch.db'), '.dump']);
  assert.deepEqual(await invoke('gateway-stop'), { stopped: true });
  assert.equal((await invoke('gateway-status')).running, false);
  assert.equal((await execute('sqlite3', [path.join(directory, 'cc-switch.db'), '.dump'])).stdout, original.stdout);
  // No health service is contacted without a configured capability. A stale
  // metadata PID is not killed by stop (including this test's own PID).
  await atomicJSON(runtimePath(directory), { pid: process.pid, instanceId: randomUUID(), configId: config.id });
  assert.equal((await invoke('gateway-stop')).stopped, false);
});

test('disable stops monitoring but retains the chosen route and halt; only exact management commands bypass the guard', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoswitch-disable-')), session = randomUUID();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await withState(directory, session, s => {
    s.enabled = true; s.autoSwitch = { enabled: true, phase: 'switched', route: 'fallback' }; s.taskHalt = { id: 'new-halt' };
  });
  const disabled = await runAutoSwitch(['disable', '--data-dir', directory, '--session', session], {});
  assert.equal(disabled.autoSwitch.enabled, false); assert.equal(disabled.autoSwitch.route, 'fallback');
  assert.equal(disabled.taskHalt.id, 'new-halt'); assert.equal((await readState(directory, session)).enabled, false);
  assert.equal(disabled.monitoringEnabled, false);
  const status = await runAutoSwitch(['status', '--data-dir', directory, '--session', session], {});
  assert.equal(status.monitoringEnabled, false); assert.equal(status.monitoringStoppedReason, 'autoswitch_disabled');
  const entry = path.join(ROOT, 'scripts', 'autoswitch.mjs');
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
