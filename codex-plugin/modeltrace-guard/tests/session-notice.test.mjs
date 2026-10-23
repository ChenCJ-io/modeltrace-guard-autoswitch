import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_TEXT, defaultCardView, gatewayNotice, noticeLanguage, startupNotice } from '../scripts/session-notice.mjs';

const fp = { company: 'a'.repeat(64), official: 'b'.repeat(64), doro: 'c'.repeat(64), copilot: 'd'.repeat(64), work: 'e'.repeat(64) };
const row = (id, name, extra = {}) => ({ id, name, category: null, fingerprint: fp[id], nativeOfficial: 0, followsNativeLogin: 0,
  managedCodexAccount: 0, delegatedAuth: 0, ...extra });
const layoutOf = (extra = {}) => ({ providers: [row('company', 'API2 copy'), row('doro', 'Doro'), row('copilot', 'Copilot', { delegatedAuth: 1 }),
  row('official', 'OpenAI Official', { category: 'official', nativeOfficial: 1, followsNativeLogin: 1 }),
  row('work', 'Work ChatGPT', { category: 'official', managedCodexAccount: 1 })],
  mode: 'proxy', attached: true, pending: false, defaultProvider: 'company', stack: { enabled: false, members: [], keys: {} },
  listener: { listen_address: '127.0.0.1', listen_port: 15721, auto_failover_enabled: 0 }, ...extra });
// Card readings carry keys; the notices must never show them.
const readCards = async () => new Map([['company', { fingerprint: fp.company, problem: null, connection: { key: 'sk-company-secret' } }],
  ['doro', { fingerprint: fp.doro, problem: null, connection: { key: 'sk-doro-secret' } }]]);
const start = { id: 'company', name: 'API2 copy', fingerprint: fp.company, transport: 'direct', key: null };
const official = { id: 'official', name: 'OpenAI Official', fingerprint: fp.official, transport: 'official', key: null };
const relay = { id: 'doro', name: 'Doro', fingerprint: fp.doro, transport: 'direct', key: null };
const copilot = { id: 'copilot', name: 'Copilot', fingerprint: fp.copilot, transport: 'ccswitch', key: null };
const config = { id: '11111111-1111-4111-8111-111111111111', backup: official, port: 15722, upstream: 'http://127.0.0.1:15721/v1',
  ccSwitchDirectory: '/fixture/cc-switch', token: 'f'.repeat(64) };
const policy = (current, extra = {}, first = start) => ({ autoSwitch: { configId: config.id, enabled: true, primary: first, current, phase: 'armed', ...extra } });
const begun = provider => ({ initialRoute: { configId: config.id, provider } });
const zh = async () => 'zh', en = async () => 'en';
const view = (extra = {}) => defaultCardView(config, { inspect: async () => layoutOf(extra), readCards });
const say = async (state, extra = {}, accountType = null) => gatewayNotice(NOTICE_TEXT.zh, config, state, await view(extra), accountType);
const notice = (connection, state, extra = {}) => startupNotice({ hook_event_name: 'SessionStart', session_id: 'thread-1', source: 'startup' },
  '/fixture', connection, {}, { language: zh, load: async () => config, read: async () => state, inspect: async () => layoutOf(), readCards, ...extra });
const OFF = '指纹监测未开启。需要时对 Codex 说“开启指纹监测”：每 16–32 次工具调用抽查一次，每次按当前上下文多发一个请求。';

test('a new gateway conversation names CCSwitch\'s default card and explains how to turn monitoring on', async () => {
  const gateway = { readyForNewThreads: true, effectiveRoute: { kind: 'gateway' } };
  assert.equal(await notice(gateway, null), `ModelTrace：本会话走 CCSwitch 默认卡「API2 copy」（第三方中转），${OFF}`);
  assert.match(await notice(gateway, null, { language: en }),
    /^ModelTrace: This conversation uses CCSwitch's default card “API2 copy” \(third-party relay\)\. Fingerprint monitoring is off\. To turn it on, tell Codex “enable fingerprint monitoring”/);
  // A connection result without a described route still means the gateway.
  assert.match(await notice({ readyForNewThreads: true }, null), /^ModelTrace：本会话走 CCSwitch 默认卡「API2 copy」/);
  const officialDefault = { inspect: async () => layoutOf({ defaultProvider: 'official' }) };
  assert.equal(await notice({ ...gateway, accountType: 'chatgpt' }, null, officialDefault),
    'ModelTrace：本会话走 CCSwitch 默认卡「OpenAI Official」（OpenAI 官方，使用当前 Codex 登录），不做指纹监测。');
  assert.equal(await notice({ ...gateway, accountType: 'other' }, null, officialDefault),
    'ModelTrace：本会话的请求会失败：CCSwitch 默认卡「OpenAI Official」是 OpenAI 官方，需要 Codex 用 ChatGPT 登录（codex login）。');
  const all = [await notice(gateway, null), await notice(gateway, null, { language: en })].join('\n');
  assert.ok(!all.includes('secret'), 'card keys never reach a notice');
});

test('a new conversation is told why it will fail when CCSwitch\'s default card cannot take it', async () => {
  const fails = (extra, accountType) => say(null, extra, accountType);
  assert.equal(await fails({ mode: 'direct', attached: false }),
    'ModelTrace：本会话的请求会失败：CCSwitch 没有为 Codex 开启本地代理（路由或聚合模式）；在 CC Switch 里打开后再发消息。');
  assert.equal(await fails({ defaultProvider: null }), 'ModelTrace：本会话的请求会失败：CCSwitch 没有选中 Codex 默认卡；在 CC Switch 里选一张后再发消息。');
  assert.equal(await fails({ defaultProvider: 'copilot', listener: { listen_address: '127.0.0.1', listen_port: 15721, auto_failover_enabled: 1 } }),
    'ModelTrace：本会话的请求会失败：CCSwitch 默认卡「Copilot」只能经 CCSwitch 使用，而 CCSwitch 开着自动故障转移，可能悄悄换卡；在 CC Switch 里关掉故障转移后再发消息。');
  assert.match(await fails({ defaultProvider: 'work' }), /^ModelTrace：本会话的请求会失败：CCSwitch 默认卡「Work ChatGPT」现在不能经 ModelTrace 使用；在终端运行 node ".+autoswitch\.mjs" check 查看原因。$/);
  assert.match(gatewayNotice(NOTICE_TEXT.zh, config, null, await defaultCardView(config, { inspect: async () => { throw new Error('locked'); } })),
    /^ModelTrace：本会话的请求会失败：读不到 CCSwitch 的配置；在终端运行 node ".+autoswitch\.mjs" check 查看原因。$/);
  // A card only CCSwitch reaches is fine as its default card with failover off.
  assert.equal(await fails({ defaultProvider: 'copilot' }), `ModelTrace：本会话走 CCSwitch 默认卡「Copilot」（第三方中转），${OFF}`);
});

test('a resumed gateway conversation reports its own card and monitoring state', async () => {
  assert.equal(await say({ enabled: true, ...policy(start) }), 'ModelTrace：本会话走 CCSwitch 默认卡「API2 copy」（第三方中转），指纹监测已开启。');
  assert.equal(await say({ enabled: false, ...policy(official, { phase: 'switched', enabled: false }) }),
    'ModelTrace：本会话走「OpenAI Official」（OpenAI 官方，使用当前 Codex 登录），不做指纹监测。新会话走 CCSwitch 默认卡「API2 copy」。');
  assert.equal(await say({ enabled: true, ...policy(relay, { phase: 'switched' }) }),
    'ModelTrace：本会话走「Doro」（第三方中转，从「API2 copy」切换而来），指纹监测已开启。新会话走 CCSwitch 默认卡「API2 copy」。');
  // Monitoring that was never enabled, was disabled or paused can be turned on again.
  assert.equal(await say({ enabled: false, ...policy(start, { enabled: false }) }), `ModelTrace：本会话走 CCSwitch 默认卡「API2 copy」（第三方中转），${OFF}`);
  assert.match(await say({ enabled: false, ...begun(start), config: { toolMin: 4, toolMax: 8 } }), /每 4–8 次工具调用/);
  assert.match(await say({ enabled: true, ...policy(start, { phase: 'awaiting_approval' }), switchRequest: { status: 'pending' } }),
    /指纹监测已开启。上次的指纹异常还在等你决定，任务保持暂停。$/);
  assert.equal(await say({ enabled: true, autoSwitch: { configId: '22222222-2222-4222-8222-222222222222', enabled: true, current: start } }),
    'ModelTrace：本会话属于旧的网关配置，经网关的请求会被拒绝；请新开会话。');
  assert.equal(await say({ initialRoute: { configId: '22222222-2222-4222-8222-222222222222', provider: start } }),
    'ModelTrace：本会话属于旧的网关配置，经网关的请求会被拒绝；请新开会话。');
  // CCSwitch's default card changed after this conversation began on its own card.
  assert.equal(await say({ enabled: false, ...begun(relay) }), `ModelTrace：本会话走「Doro」（第三方中转），${OFF}新会话走 CCSwitch 默认卡「API2 copy」。`);
});

test('a started conversation on a card only CCSwitch reaches fails once CCSwitch\'s default card moves; direct ones go on', async () => {
  assert.equal(await say({ enabled: false, ...begun(copilot) }),
    'ModelTrace：本会话的请求会失败：「Copilot」只能作为 CCSwitch 默认卡使用，而 CCSwitch 默认卡已换成「API2 copy」；在 CC Switch 里换回「Copilot」，或新开会话。');
  assert.match(await say({ enabled: false, ...begun(copilot) }, { defaultProvider: 'copilot', listener: { listen_address: '127.0.0.1', listen_port: 15721, auto_failover_enabled: 1 } }),
    /^ModelTrace：本会话的请求会失败：CCSwitch 默认卡「Copilot」只能经 CCSwitch 使用，而 CCSwitch 开着自动故障转移/);
  assert.match(await say({ enabled: false, ...begun(copilot) }, { mode: 'direct', attached: false }), /^ModelTrace：本会话的请求会失败：CCSwitch 没有为 Codex 开启本地代理/);
  assert.equal(await say({ enabled: false, ...begun(relay) }, { mode: 'direct', attached: false }), `ModelTrace：本会话走「Doro」（第三方中转），${OFF}`);
  // The gateway reads CCSwitch on every request, whatever the route.
  const unreadable = await defaultCardView(config, { inspect: async () => { throw new Error('locked'); } });
  for (const state of [{ enabled: false, ...begun(relay) }, { enabled: false, ...policy(official, { phase: 'switched', enabled: false }) }]) {
    assert.match(gatewayNotice(NOTICE_TEXT.zh, config, state, unreadable), /^ModelTrace：本会话的请求会失败：读不到 CCSwitch 的配置/);
  }
  assert.equal(await say({ enabled: false, ...policy(official, { phase: 'switched', enabled: false }) }, {}, 'other'),
    'ModelTrace：本会话的请求会失败：「OpenAI Official」是 OpenAI 官方，需要 Codex 用 ChatGPT 登录（codex login）。');
  // An edited or removed card is refused by the gateway, whatever its route.
  const edited = { providers: layoutOf().providers.map(p => (p.id === 'doro' ? { ...p, fingerprint: 'f'.repeat(64) } : p)) };
  assert.equal(await say({ enabled: true, ...policy(relay, { phase: 'switched' }) }, edited),
    'ModelTrace：本会话的请求会失败：「Doro」在 CCSwitch 里被改过或删掉了，本会话不再转发到它（以免悄悄换到另一个中转）；新开会话即可用上改过的卡。');
  assert.match(await say({ enabled: false, ...begun(relay) }, { providers: layoutOf().providers.filter(p => p.id !== 'doro') }), /「Doro」在 CCSwitch 里被改过或删掉了/);
});

test('a conversation that bypasses the gateway says where it actually goes, including a personal subscription', async () => {
  const bypass = { phase: 'conflict', readyForNewThreads: false };
  assert.equal(await notice({ ...bypass, effectiveRoute: { kind: 'openai' }, accountType: 'chatgpt' }, null),
    'ModelTrace：本会话没有经过 ModelTrace 网关，实际走 OpenAI 官方（ChatGPT 登录，消耗个人订阅），不能做指纹监测，也不能切换渠道。需要时让 Codex 重新接入 ModelTrace。');
  assert.match(await notice({ ...bypass, effectiveRoute: { kind: 'openai' }, accountType: 'other' }, null), /实际走 OpenAI 官方（使用当前 Codex 登录），/);
  const loopback = { ...bypass, effectiveRoute: { kind: 'loopback', port: 15721, provider: 'custom' } };
  assert.match(await notice(loopback, null), /实际走 CCSwitch 当前卡「API2 copy」，/);
  assert.match(await notice(loopback, null, { inspect: async () => layoutOf({ defaultProvider: 'missing' }) }), /实际走 CCSwitch 当前选中的卡，/);
  assert.match(await notice(loopback, null, { inspect: async () => { throw new Error('locked'); } }), /实际走「custom」，/);
  assert.match(await notice({ ...bypass, effectiveRoute: { kind: 'custom', provider: 'api2' } }, null), /实际走「api2」，/);
  assert.match(await notice({ ...bypass, effectiveRoute: { kind: 'unknown' } }, null), /实际走一个未识别的渠道，/);
  assert.equal(await notice({ ...bypass, effectiveRoute: { kind: 'loopback', port: 15722, provider: 'openai' } }, null),
    'ModelTrace：本会话指向过期的 ModelTrace 网关地址，请求会失败。需要时让 Codex 重新接入 ModelTrace。');
  assert.match(await notice({ ...bypass, effectiveRoute: { kind: 'openai' }, accountType: 'chatgpt' }, null, { language: en }),
    /^ModelTrace: This conversation does not go through the ModelTrace gateway; it actually uses OpenAI official \(ChatGPT login, personal subscription\)\./);
});

test('a resumed conversation created outside the gateway is reported even when new conversations are connected', async () => {
  const message = await notice({ phase: 'installed', readyForNewThreads: true, effectiveRoute: { kind: 'gateway' },
    threadRoute: { kind: 'loopback', port: 15721, provider: 'custom' } }, { enabled: true, ...policy(start) });
  assert.equal(message, 'ModelTrace：本会话没有经过 ModelTrace 网关，实际走 CCSwitch 当前卡「API2 copy」，不能做指纹监测，也不能切换渠道；新开的会话会经过网关。');
  assert.match(await notice({ readyForNewThreads: true, effectiveRoute: { kind: 'gateway' }, threadRoute: { kind: 'gateway' } },
    { enabled: true, ...policy(start) }), /^ModelTrace：本会话走 CCSwitch 默认卡「API2 copy」（第三方中转），指纹监测已开启。$/);
});

test('notices never echo capabilities or control characters and never fail the session', async () => {
  const capability = `http://127.0.0.1:15722/${config.token}/v1`;
  const hostile = layoutOf({ providers: layoutOf().providers.map(p => (p.id === 'company' ? { ...p, name: `evil\n${capability}` } : p)) });
  const messages = [await startupNotice({ hook_event_name: 'SessionStart', session_id: 'thread-1' }, '/fixture', { readyForNewThreads: true },
    {}, { language: zh, load: async () => config, read: async () => null, inspect: async () => hostile, readCards }),
  await say({ enabled: true, ...policy({ ...relay, name: `evil\n${capability}` }) })];
  for (const message of messages) { assert.ok(!message.includes(config.token)); assert.ok(!message.includes('\n')); }
  assert.equal(await startupNotice({ hook_event_name: 'SessionStart' }, '/fixture', { readyForNewThreads: true }, {},
    { language: zh, load: async () => { throw new Error(`no config at ${capability}`); } }), null);
  assert.equal(await startupNotice({ hook_event_name: 'SessionStart', session_id: 'thread-1' }, '/fixture', { readyForNewThreads: true }, {},
    { language: zh, load: async () => config, read: async () => { throw new Error('corrupt state'); } }), null);
  assert.equal(await notice({ readyForNewThreads: false }, null), null, 'An undescribed broken connection keeps the generic startup warning');
});

test('the notice language follows an override, the POSIX locale, then the macOS preferred language', async () => {
  const never = async () => assert.fail('must not read macOS preferences');
  assert.equal(await noticeLanguage({ MODELTRACE_LANG: 'zh' }, { appleLanguage: never }), 'zh');
  assert.equal(await noticeLanguage({ MODELTRACE_LANG: 'en', LANG: 'zh_CN.UTF-8' }, { appleLanguage: never }), 'en');
  assert.equal(await noticeLanguage({ LANG: 'zh_CN.UTF-8' }, { appleLanguage: never }), 'zh');
  assert.equal(await noticeLanguage({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' }, { appleLanguage: never }), 'en');
  assert.equal(await noticeLanguage({ LANG: 'C.UTF-8' }, { platform: 'darwin', appleLanguage: async () => 'zh-Hans-CN' }), 'zh');
  assert.equal(await noticeLanguage({}, { platform: 'darwin', appleLanguage: async () => 'en-US' }), 'en');
  assert.ok(['zh', 'en'].includes(await noticeLanguage({}, { platform: 'darwin', appleLanguage: async () => { throw new Error('no defaults'); } })));
  assert.ok(['zh', 'en'].includes(await noticeLanguage({}, { platform: 'linux', appleLanguage: never })));
});
