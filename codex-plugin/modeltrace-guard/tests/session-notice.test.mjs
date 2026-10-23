import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_TEXT, gatewayNotice, noticeLanguage, startupNotice } from '../scripts/session-notice.mjs';

const primary = { id: 'company', name: 'API2 copy', fingerprint: 'a'.repeat(64), transport: 'ccswitch', key: 'api2-copy' };
const official = { id: 'official', name: 'OpenAI Official', fingerprint: 'b'.repeat(64), transport: 'official', key: null };
const relay = { id: 'doro', name: 'Doro', fingerprint: 'c'.repeat(64), transport: 'ccswitch', key: 'doro' };
const config = { id: '11111111-1111-4111-8111-111111111111', primary, backup: official, port: 15722,
  ccSwitchDirectory: '/fixture/cc-switch', token: 'f'.repeat(64) };
const layout = { listener: { listen_port: 15721 }, defaultProvider: 'company', providers: [{ id: 'company', name: 'API2 copy' }] };
const policy = (current, extra = {}) => ({ autoSwitch: { configId: config.id, enabled: true, primary, current, phase: 'armed', ...extra } });
const zh = async () => 'zh', en = async () => 'en';
const say = state => gatewayNotice(NOTICE_TEXT.zh, config, state);
const notice = (connection, state, extra = {}) => startupNotice({ hook_event_name: 'SessionStart', session_id: 'thread-1', source: 'startup' },
  '/fixture', connection, {}, { language: zh, load: async () => config, read: async () => state, ...extra });

test('a new gateway conversation names the primary and explains how to turn monitoring on', async () => {
  assert.equal(await notice({ readyForNewThreads: true, effectiveRoute: { kind: 'gateway' } }, null),
    'ModelTrace：本会话走「API2 copy」（主渠道，第三方中转），指纹监测未开启。需要时对 Codex 说“开启指纹监测”：每 16–32 次工具调用抽查一次，每次按当前上下文多发一个请求。');
  assert.match(await notice({ readyForNewThreads: true, effectiveRoute: { kind: 'gateway' } }, null, { language: en }),
    /^ModelTrace: This conversation uses “API2 copy” \(primary route, third-party relay\)\. Fingerprint monitoring is off\. To turn it on, tell Codex “enable fingerprint monitoring”/);
  // A connection result without a described route still means the gateway.
  assert.match(await notice({ readyForNewThreads: true }, null), /^ModelTrace：本会话走「API2 copy」/);
});

test('a resumed gateway conversation reports its own saved route and monitoring state', () => {
  assert.equal(say({ enabled: true, ...policy(primary) }), 'ModelTrace：本会话走「API2 copy」（主渠道，第三方中转），指纹监测已开启。');
  assert.equal(say({ enabled: false, ...policy(official, { phase: 'switched', enabled: false }) }),
    'ModelTrace：本会话走「OpenAI Official」（OpenAI 官方，使用当前 Codex 登录），不做指纹监测；新会话仍走主渠道「API2 copy」。');
  assert.equal(say({ enabled: true, ...policy(relay, { phase: 'switched' }) }), 'ModelTrace：本会话走「Doro」（第三方中转，已从主渠道切换），指纹监测已开启。');
  assert.equal(say({ enabled: false, ...policy(primary, { enabled: false }) }),
    'ModelTrace：本会话走「API2 copy」（主渠道，第三方中转），指纹监测已停止，本会话不能重新开启；需要时新开会话再说“开启指纹监测”。');
  assert.match(say({ enabled: false, initialRoute: { configId: config.id, provider: primary }, config: { toolMin: 4, toolMax: 8 } }), /每 4–8 次工具调用/);
  assert.match(say({ enabled: true, ...policy(primary, { phase: 'awaiting_approval' }), switchRequest: { status: 'pending' } }),
    /指纹监测已开启。上次的指纹异常还在等你决定，任务保持暂停。$/);
  assert.equal(say({ enabled: true, autoSwitch: { configId: '22222222-2222-4222-8222-222222222222', enabled: true, current: primary } }),
    'ModelTrace：本会话属于旧的网关配置，经网关的请求会被拒绝；请新开会话。');
  assert.equal(say({ initialRoute: { configId: '22222222-2222-4222-8222-222222222222', provider: primary } }),
    'ModelTrace：本会话属于旧的网关配置，经网关的请求会被拒绝；请新开会话。');
});

test('an Official primary is never offered monitoring', () => {
  assert.equal(gatewayNotice(NOTICE_TEXT.zh, { ...config, primary: official, backup: primary }, null),
    'ModelTrace：本会话走「OpenAI Official」（主渠道，OpenAI 官方），不做指纹监测。');
});

test('a conversation that bypasses the gateway says where it actually goes, including a personal subscription', async () => {
  const bypass = { phase: 'conflict', readyForNewThreads: false };
  assert.equal(await notice({ ...bypass, effectiveRoute: { kind: 'openai' }, accountType: 'chatgpt' }, null),
    'ModelTrace：本会话没有经过 ModelTrace 网关，实际走 OpenAI 官方（ChatGPT 登录，消耗个人订阅），不能做指纹监测，也不能切换渠道。需要时让 Codex 重新接入 ModelTrace。');
  assert.match(await notice({ ...bypass, effectiveRoute: { kind: 'openai' }, accountType: 'other' }, null), /实际走 OpenAI 官方（使用当前 Codex 登录），/);
  const loopback = { ...bypass, effectiveRoute: { kind: 'loopback', port: 15721, provider: 'custom' } };
  assert.match(await notice(loopback, null, { inspect: async () => layout }), /实际走 CCSwitch 当前卡「API2 copy」，/);
  assert.match(await notice(loopback, null, { inspect: async () => ({ ...layout, defaultProvider: 'missing' }) }), /实际走 CCSwitch 当前选中的卡，/);
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
    threadRoute: { kind: 'loopback', port: 15721, provider: 'custom' } }, { enabled: true, ...policy(primary) }, { inspect: async () => layout });
  assert.equal(message, 'ModelTrace：本会话没有经过 ModelTrace 网关，实际走 CCSwitch 当前卡「API2 copy」，不能做指纹监测，也不能切换渠道；新开的会话会经过网关。');
  assert.match(await notice({ readyForNewThreads: true, effectiveRoute: { kind: 'gateway' }, threadRoute: { kind: 'gateway' } },
    { enabled: true, ...policy(primary) }), /^ModelTrace：本会话走「API2 copy」（主渠道，第三方中转），指纹监测已开启。$/);
});

test('notices never echo capabilities or control characters and never fail the session', async () => {
  const capability = `http://127.0.0.1:15722/${config.token}/v1`;
  const hostile = { ...config, primary: { ...primary, name: `evil\n${capability}` } };
  const message = await startupNotice({ hook_event_name: 'SessionStart', session_id: 'thread-1' }, '/fixture', { readyForNewThreads: true },
    {}, { language: zh, load: async () => hostile, read: async () => null });
  assert.ok(!message.includes(config.token)); assert.ok(!message.includes('\n'));
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
