import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULTS, readState } from './state.mjs';
import { inspectCCSwitch, loadGatewayConfig } from './provider-config.mjs';

const run = promisify(execFile);

// Codex shows a hook's systemMessage verbatim; the model never translates it.
// Pick the user's language from an explicit override, the POSIX locale, then
// the macOS preferred language (GUI terminals often start without LANG).
export async function noticeLanguage(env = process.env, { platform = process.platform, appleLanguage = readAppleLanguage } = {}) {
  const pick = value => (/^zh(?:[-_.]|$)/i.test(value) ? 'zh' : 'en');
  if (env.MODELTRACE_LANG?.trim()) return pick(env.MODELTRACE_LANG.trim());
  const locale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find(value => value?.trim() && !/^(?:C|POSIX)(?:[.@]|$)/i.test(value.trim()));
  if (locale) return pick(locale.trim());
  if (platform === 'darwin') {
    try { const first = await appleLanguage(); if (first) return pick(first); } catch {}
  }
  return pick(Intl.DateTimeFormat().resolvedOptions().locale || '');
}

async function readAppleLanguage() {
  const { stdout } = await run('defaults', ['read', '-g', 'AppleLanguages'], { timeout: 1000 });
  return stdout.match(/[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*/)?.[0] || null;
}

// Chinese text puts a space before a Latin-script name ("走 OpenAI", "走「X」").
const spaced = target => (/^[A-Za-z]/.test(target) ? ` ${target}` : target);
export const NOTICE_TEXT = {
  zh: {
    prefix: 'ModelTrace：',
    route: (name, role) => `本会话走「${name}」（${role}）`,
    roles: { primary: '主渠道，第三方中转', primaryOfficial: '主渠道，OpenAI 官方', official: 'OpenAI 官方，使用当前 Codex 登录',
      thirdParty: '第三方中转', switched: '第三方中转，已从主渠道切换' },
    on: '，指纹监测已开启。',
    off: (min, max) => `，指纹监测未开启。需要时对 Codex 说“开启指纹监测”：每 ${min}–${max} 次工具调用抽查一次，每次按当前上下文多发一个请求。`,
    official: primary => `，不做指纹监测${primary ? `；新会话仍走主渠道「${primary}」` : ''}。`,
    stopped: '，指纹监测已停止，本会话不能重新开启；需要时新开会话再说“开启指纹监测”。',
    pending: '上次的指纹异常还在等你决定，任务保持暂停。',
    staleConfig: '本会话属于旧的网关配置，经网关的请求会被拒绝；请新开会话。',
    bypass: target => `本会话没有经过 ModelTrace 网关，实际走${spaced(target)}，不能做指纹监测，也不能切换渠道。需要时让 Codex 重新接入 ModelTrace。`,
    bypassThread: target => `本会话没有经过 ModelTrace 网关，实际走${spaced(target)}，不能做指纹监测，也不能切换渠道；新开的会话会经过网关。`,
    staleGateway: '本会话指向过期的 ModelTrace 网关地址，请求会失败。需要时让 Codex 重新接入 ModelTrace。',
    targets: { card: name => `CCSwitch 当前卡「${name}」`, anyCard: 'CCSwitch 当前选中的卡', chatgpt: 'OpenAI 官方（ChatGPT 登录，消耗个人订阅）',
      openai: 'OpenAI 官方（使用当前 Codex 登录）', custom: name => `「${name}」`, unknown: '一个未识别的渠道' },
  },
  en: {
    prefix: 'ModelTrace: ',
    route: (name, role) => `This conversation uses “${name}” (${role})`,
    roles: { primary: 'primary route, third-party relay', primaryOfficial: 'primary route, OpenAI official', official: 'OpenAI official, current Codex login',
      thirdParty: 'third-party relay', switched: 'third-party relay, switched from the primary' },
    on: '. Fingerprint monitoring is on.',
    off: (min, max) => `. Fingerprint monitoring is off. To turn it on, tell Codex “enable fingerprint monitoring”: it samples once every ${min}–${max} tool calls, and each sample sends one extra request with the current context.`,
    official: primary => `. No fingerprint monitoring${primary ? `; new conversations still use the primary “${primary}”` : ''}.`,
    stopped: '. Fingerprint monitoring was stopped and cannot restart in this conversation; start a new conversation and ask again if needed.',
    pending: ' A fingerprint mismatch is still waiting for your decision; the task stays paused.',
    staleConfig: 'This conversation belongs to an earlier gateway configuration; requests through the gateway will be refused. Start a new conversation.',
    bypass: target => `This conversation does not go through the ModelTrace gateway; it actually uses ${target}. Monitoring and route switching are unavailable here. Ask Codex to reconnect ModelTrace if needed.`,
    bypassThread: target => `This conversation does not go through the ModelTrace gateway; it actually uses ${target}. Monitoring and route switching are unavailable here; new conversations go through the gateway.`,
    staleGateway: 'This conversation points at an outdated ModelTrace gateway address, so its requests will fail. Ask Codex to reconnect ModelTrace if needed.',
    targets: { card: name => `CCSwitch's current card “${name}”`, anyCard: "CCSwitch's currently selected card", chatgpt: 'OpenAI official (ChatGPT login, personal subscription)',
      openai: 'OpenAI official (current Codex login)', custom: name => `“${name}”`, unknown: 'an unrecognized route' },
  },
};
const safeName = value => (typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '?');

// A thread routed by the gateway: report its saved route, or the primary that
// a brand-new thread receives on its first request, plus the monitoring state.
export function gatewayNotice(text, config, state) {
  const p = state?.autoSwitch;
  if ((p && p.configId !== config.id) || (!p && state?.initialRoute && state.initialRoute.configId !== config.id)) return text.prefix + text.staleConfig;
  const current = p?.current || state?.initialRoute?.provider || config.primary;
  const primary = current.id === config.primary.id, official = current.transport === 'official';
  const role = official ? (primary ? 'primaryOfficial' : 'official') : primary ? 'primary' : p?.phase === 'switched' ? 'switched' : 'thirdParty';
  let message = text.prefix + text.route(safeName(current.name), text.roles[role]);
  if (official) message += text.official(primary ? null : safeName(config.primary.name));
  else if (state?.enabled === true) message += text.on;
  else if (p && p.enabled === false) message += text.stopped;
  else message += text.off(state?.config?.toolMin ?? DEFAULTS.toolMin, state?.config?.toolMax ?? DEFAULTS.toolMax);
  if (state?.switchRequest?.status === 'pending') message += text.pending;
  return message;
}

// A thread that bypasses the gateway: describe where it actually goes without
// echoing any URL, path or header (the gateway capability lives in its path).
export function bypassNotice(text, config, route, { accountType = null, card = null, thread = false } = {}) {
  if (route.kind === 'loopback' && route.port === config.port) return text.prefix + text.staleGateway;
  const target = route.kind === 'openai' ? (accountType === 'chatgpt' ? text.targets.chatgpt : text.targets.openai)
    : route.kind === 'ccswitch' ? (card ? text.targets.card(safeName(card)) : text.targets.anyCard)
      : route.provider ? text.targets.custom(safeName(route.provider)) : text.targets.unknown;
  return text.prefix + (thread ? text.bypassThread : text.bypass)(target);
}

// Never throws: a notice must not block or fail the session it describes.
export async function startupNotice(event, directory, connection, env = process.env, {
  language = noticeLanguage, load = loadGatewayConfig, read = readState, inspect = inspectCCSwitch,
} = {}) {
  try {
    const config = await load(directory);
    const text = NOTICE_TEXT[await language(env)];
    const threadRoute = connection.threadRoute?.kind ? connection.threadRoute : null;
    let route = threadRoute || connection.effectiveRoute || null;
    if (!route) route = connection.readyForNewThreads ? { kind: 'gateway' } : null;
    if (!route) return null;
    if (route.kind === 'gateway') {
      const session = typeof event.session_id === 'string' && event.session_id ? event.session_id : null;
      return gatewayNotice(text, config, session ? await read(directory, session) : null);
    }
    let card = null;
    if (route.kind === 'loopback') {
      const layout = await inspect(config.ccSwitchDirectory).catch(() => null);
      if (layout?.listener && Number(layout.listener.listen_port) === route.port) {
        route = { kind: 'ccswitch' };
        card = layout.providers?.find(provider => provider.id === layout.defaultProvider)?.name || null;
      }
    }
    return bypassNotice(text, config, route, { accountType: connection.accountType, card, thread: Boolean(threadRoute) });
  } catch { return null; }
}
