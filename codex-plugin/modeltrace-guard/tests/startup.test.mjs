import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ROOT } from '../scripts/guard.mjs';
import { ensureGatewayForStartup, requireTrustedStartupHook } from '../scripts/startup.mjs';
import { gatewayRuntimeProblem } from '../scripts/switch-gateway.mjs';

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

test('a configuration from before 0.5 asks for an explicit reconnect instead of starting anything', async () => {
  const output = await ensureGatewayForStartup({ hook_event_name: 'SessionStart', source: 'startup' }, '/fixture', { MODELTRACE_LANG: 'zh' }, {
    integrationStatus: async () => ({ phase: 'config_outdated', readyForNewThreads: false }), start: async () => assert.fail('must not start'),
  });
  assert.match(output.systemMessage, /^ModelTrace：插件已升级到 0\.5，网关配置需要更新：在终端运行 node ".+autoswitch\.mjs" connect/);
  assert.match(output.systemMessage, /对 Codex 说“重新接入 ModelTrace”，但这个会话会随之断开/);
  const english = await ensureGatewayForStartup({ hook_event_name: 'SessionStart', source: 'resume' }, '/fixture', { MODELTRACE_LANG: 'en' }, {
    integrationStatus: async () => ({ phase: 'config_outdated', readyForNewThreads: false }), start: async () => assert.fail('must not start'),
  });
  assert.match(english.systemMessage, /^ModelTrace: The plugin was upgraded to 0\.5/);
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

test('a gateway that cannot start tells the user why and how to restore the previous provider', async () => {
  const reason = gatewayRuntimeProblem('20.18.0', {});
  const result = await ensureGatewayForStartup({ hook_event_name: 'SessionStart' }, '/fixture', {}, {
    integrationStatus: async () => ({ readyForNewThreads: true, phase: 'installed' }),
    start: async () => { throw new Error(`${reason}. Put a newer node first on the PATH that Codex hooks use`); },
  });
  assert.ok(result.systemMessage.includes('20.18.0'));
  assert.ok(result.systemMessage.includes(`node "${path.join(ROOT, 'scripts', 'autoswitch.mjs')}" disconnect`));
});

test('the gateway requires a Node runtime with zstd request bodies and native proxyEnv', () => {
  const zstd = { zstdDecompress() {} };
  for (const version of ['25.0.0', '24.5.0', '24.11.1', '22.21.0', '22.30.2']) assert.equal(gatewayRuntimeProblem(version, zstd), null, version);
  for (const version of ['18.20.4', '20.19.0', '22.20.0', '23.11.0', '24.4.1']) assert.match(gatewayRuntimeProblem(version, zstd), /22\.21\+ or 24\.5\+/, version);
  assert.match(gatewayRuntimeProblem('24.11.1', {}), /zstd/);
});

test('opening a conversation shows its route notice; compaction stays quiet and reads no extra state', async () => {
  const thread = '01a16277-104c-79e2-b928-933686fef68f';
  for (const [source, threadId] of [['startup', null], ['resume', thread], ['clear', null], [undefined, null]]) {
    const seen = [];
    const output = await ensureGatewayForStartup({ hook_event_name: 'SessionStart', session_id: thread, source }, '/fixture', {}, {
      integrationStatus: async (directory, env, options) => { seen.push(options); return { phase: 'installed', readyForNewThreads: true, effectiveRoute: { kind: 'gateway' } }; },
      start: async () => ({ running: true, readiness: 'ready' }),
      notice: async (event, directory, connection) => { assert.equal(connection.effectiveRoute.kind, 'gateway'); return 'ModelTrace：本会话走「主渠道」'; },
    });
    assert.deepEqual(output, { systemMessage: 'ModelTrace：本会话走「主渠道」' }, String(source));
    assert.deepEqual(seen, [{ describe: true, threadId }], String(source));
  }
  const seen = [];
  const compact = await ensureGatewayForStartup({ hook_event_name: 'SessionStart', session_id: thread, source: 'compact' }, '/fixture', {}, {
    integrationStatus: async (directory, env, options) => { seen.push(options); return { phase: 'installed', readyForNewThreads: true }; },
    start: async () => ({ running: true, readiness: 'ready' }), notice: async () => assert.fail('compaction keeps the route'),
  });
  assert.deepEqual(compact, {}); assert.deepEqual(seen, [{}]);
  const silent = await ensureGatewayForStartup({ hook_event_name: 'SessionStart' }, '/fixture', {}, {
    integrationStatus: async () => ({ phase: 'installed', readyForNewThreads: true }),
    start: async () => ({ running: true, readiness: 'ready' }), notice: async () => null,
  });
  assert.deepEqual(silent, {});
});

test('a broken connection names the route a bypassing conversation actually uses, without starting the gateway', async () => {
  const bypass = await ensureGatewayForStartup({ hook_event_name: 'SessionStart', source: 'startup' }, '/fixture', {}, {
    integrationStatus: async () => ({ phase: 'conflict', readyForNewThreads: false, effectiveRoute: { kind: 'openai' }, accountType: 'chatgpt' }),
    start: async () => assert.fail('must not start'), notice: async () => 'ModelTrace：本会话没有经过 ModelTrace 网关，实际走 OpenAI 官方',
  });
  assert.deepEqual(bypass, { systemMessage: 'ModelTrace：本会话没有经过 ModelTrace 网关，实际走 OpenAI 官方' });
  // Still routed to the gateway, but not owned as configured: keep the generic repair warning.
  const overridden = await ensureGatewayForStartup({ hook_event_name: 'SessionStart', source: 'startup' }, '/fixture', {}, {
    integrationStatus: async () => ({ phase: 'overridden', readyForNewThreads: false, effectiveRoute: { kind: 'gateway' } }),
    start: async () => assert.fail('must not start'), notice: async () => assert.fail('the gateway route is not a bypass'),
  });
  assert.match(overridden.systemMessage, /no longer current.*monitoring was not enabled/);
  const undescribed = await ensureGatewayForStartup({ hook_event_name: 'SessionStart', source: 'startup' }, '/fixture', {}, {
    integrationStatus: async () => ({ phase: 'conflict', readyForNewThreads: false, effectiveRoute: { kind: 'custom', provider: 'relay' } }),
    start: async () => assert.fail('must not start'), notice: async () => null,
  });
  assert.match(undescribed.systemMessage, /no longer current/);
});
