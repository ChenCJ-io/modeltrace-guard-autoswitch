import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ROOT } from '../scripts/guard.mjs';
import { ensureGatewayForStartup, requireTrustedStartupHook } from '../scripts/startup.mjs';

test('ordinary startup starts only an owned and effective gateway, without enabling or changing a thread', async () => {
  const calls = [], event = { hook_event_name: 'SessionStart', session_id: 'native-session' };
  const deps = { integrationStatus: async directory => { calls.push(['status', directory]); return { phase: 'installed', readyForNewThreads: true }; },
    start: async directory => { calls.push(['start', directory]); return { running: true, readiness: 'ready' }; } };
  assert.deepEqual(await ensureGatewayForStartup(event, '/fixture', {}, deps), {});
  assert.deepEqual(calls, [['status', '/fixture'], ['start', '/fixture']]);
  assert.deepEqual(event, { hook_event_name: 'SessionStart', session_id: 'native-session' });
});

test('startup leaves absent, removed, changed or overridden connections alone', async () => {
  for (const phase of ['not_installed', 'removed', 'conflict', 'overridden', 'install_pending', 'stale_gateway_config']) {
    const output = await ensureGatewayForStartup({ hook_event_name: 'SessionStart' }, '/fixture', {}, {
      integrationStatus: async () => ({ phase, readyForNewThreads: false }), start: async () => assert.fail('must not start'),
    });
    if (['not_installed', 'removed'].includes(phase)) assert.deepEqual(output, {});
    else assert.match(output.systemMessage, /not changed and monitoring was not enabled/);
  }
});

test('probe and subagent startup cannot recurse into gateway setup', async () => {
  for (const [event, env] of [[{ hook_event_name: 'SessionStart' }, { MODELTRACE_PROBE_PROCESS: '1' }],
    [{ hook_event_name: 'SessionStart', agent_id: 'child' }, {}], [{ hook_event_name: 'SessionStart', parent_session_id: 'parent' }, {}],
    [{ hook_event_name: 'PostToolUse' }, {}]]) {
    assert.deepEqual(await ensureGatewayForStartup(event, '/fixture', env, {
      integrationStatus: async () => assert.fail('must not inspect'), start: async () => assert.fail('must not start'),
    }), {});
  }
});

test('startup reports readiness failures without exposing capabilities or changing route', async () => {
  const result = await ensureGatewayForStartup({ hook_event_name: 'SessionStart' }, '/fixture', {}, {
    integrationStatus: async () => ({ readyForNewThreads: true, phase: 'installed' }),
    start: async () => { throw new Error('http://127.0.0.1:1234/private-capability/v1'); },
  });
  assert.match(result.systemMessage, /could not be prepared/);
  assert.ok(!JSON.stringify(result).includes('private-capability'));
});

test('ordinary entry requires the actual loaded and trusted synchronous startup handler', async () => {
  const config = JSON.parse(await readFile(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  const handler = config.hooks.SessionStart.flatMap(group => group.hooks).find(hook => !hook.async);
  assert.ok(handler.command.includes('startup.mjs'));
  const hook = { ...handler, eventName: 'sessionStart', async: false, enabled: true, trustStatus: 'trusted',
    handlerType: 'command', pluginId: 'modeltrace-guard-autoswitch@fixture', sourcePath: path.join(ROOT, 'hooks/hooks.json') };
  const client = value => ({ request: async method => { assert.equal(method, 'hooks/list'); return { data: [{ hooks: value }] }; } });
  await requireTrustedStartupHook(client([hook]), ROOT);
  for (const change of [{ trustStatus: 'untrusted' }, { async: true }, { enabled: false }, { command: 'node elsewhere.mjs' }, { sourcePath: '/missing/hooks/hooks.json' }]) {
    await assert.rejects(requireTrustedStartupHook(client([{ ...hook, ...change }]), ROOT), /Review.*startup hook/);
  }
});
