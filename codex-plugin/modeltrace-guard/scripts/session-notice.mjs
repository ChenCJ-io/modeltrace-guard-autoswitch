import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULTS, readState } from './state.mjs';
import { assertProviderCurrent, ccswitchMode, defaultCardId, inspectCCSwitch, loadGatewayConfig, officialLogin, routeDescriptor, verifyRouteLayout } from './provider-config.mjs';

const run = promisify(execFile);
const AUTOSWITCH = fileURLToPath(new URL('./autoswitch.mjs', import.meta.url));

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
    route: (label, role) => `本会话走${spaced(label)}（${role}）`,
    defaultCard: name => `CCSwitch 默认卡「${name}」`, card: name => `「${name}」`,
    roles: { official: 'OpenAI 官方，使用当前 Codex 登录', thirdParty: '第三方中转', switched: from => `第三方中转，从「${from}」切换而来` },
    on: '，指纹监测已开启。',
    off: (min, max) => `，指纹监测未开启。需要时对 Codex 说“开启指纹监测”：每 ${min}–${max} 次工具调用抽查一次，每次按当前上下文多发一个请求。`,
    official: '，不做指纹监测。',
    newConversations: name => `新会话走 CCSwitch 默认卡「${name}」。`,
    pending: '上次的指纹异常还在等你决定，任务保持暂停。',
    failing: reason => `本会话的请求会失败：${reason}`,
    reasons: {
      proxyOff: () => 'CCSwitch 没有为 Codex 开启本地代理（路由或聚合模式）；在 CC Switch 里打开后再发消息。',
      noDefault: () => 'CCSwitch 没有选中 Codex 默认卡；在 CC Switch 里选一张后再发消息。',
      failover: label => `${label}只能经 CCSwitch 使用，而 CCSwitch 开着自动故障转移，可能悄悄换卡；在 CC Switch 里关掉故障转移后再发消息。`,
      officialLogin: label => `${label}是 OpenAI 官方，需要 Codex 用 ChatGPT 登录（codex login）。`,
      defaultChanged: (label, now) => `${label}只能作为 CCSwitch 默认卡使用，而 CCSwitch 默认卡已换成「${now}」；在 CC Switch 里换回${label}，或新开会话。`,
      notInStack: label => `${label}已不在 CCSwitch 聚合里；在 CC Switch 的 Codex 聚合里重新加上它。`,
      cardChanged: label => `${label}在 CCSwitch 里被改过或删掉了，本会话不再转发到它（以免悄悄换到另一个中转）；新开会话即可用上改过的卡。`,
      unusable: label => `${label}现在不能经 ModelTrace 使用；在终端运行 node "${AUTOSWITCH}" check 查看原因。`,
      unreadable: () => `读不到 CCSwitch 的配置；在终端运行 node "${AUTOSWITCH}" check 查看原因。`,
    },
    staleConfig: '本会话属于旧的网关配置，经网关的请求会被拒绝；请新开会话。',
    outdated: `插件已升级到 0.5，网关配置需要更新：在终端运行 node "${AUTOSWITCH}" connect（网关地址不变，之后新会话走 CCSwitch 默认卡），然后新开会话。也可以对 Codex 说“重新接入 ModelTrace”，但这个会话会随之断开。`,
    bypass: target => `本会话没有经过 ModelTrace 网关，实际走${spaced(target)}，不能做指纹监测，也不能切换渠道。需要时让 Codex 重新接入 ModelTrace。`,
    bypassThread: target => `本会话没有经过 ModelTrace 网关，实际走${spaced(target)}，不能做指纹监测，也不能切换渠道；新开的会话会经过网关。`,
    staleGateway: '本会话指向过期的 ModelTrace 网关地址，请求会失败。需要时让 Codex 重新接入 ModelTrace。',
    targets: { card: name => `CCSwitch 当前卡「${name}」`, anyCard: 'CCSwitch 当前选中的卡', chatgpt: 'OpenAI 官方（ChatGPT 登录，消耗个人订阅）',
      openai: 'OpenAI 官方（使用当前 Codex 登录）', custom: name => `「${name}」`, unknown: '一个未识别的渠道' },
  },
  en: {
    prefix: 'ModelTrace: ',
    route: (label, role) => `This conversation uses ${label} (${role})`,
    defaultCard: name => `CCSwitch's default card “${name}”`, card: name => `“${name}”`,
    roles: { official: 'OpenAI official, current Codex login', thirdParty: 'third-party relay', switched: from => `third-party relay, switched from “${from}”` },
    on: '. Fingerprint monitoring is on.',
    off: (min, max) => `. Fingerprint monitoring is off. To turn it on, tell Codex “enable fingerprint monitoring”: it samples once every ${min}–${max} tool calls, and each sample sends one extra request with the current context.`,
    official: '. No fingerprint monitoring.',
    newConversations: name => ` New conversations use CCSwitch's default card “${name}”.`,
    pending: ' A fingerprint mismatch is still waiting for your decision; the task stays paused.',
    failing: reason => `Requests in this conversation will fail: ${reason}`,
    reasons: {
      proxyOff: () => 'CCSwitch runs no local proxy for Codex (Routing or Aggregation mode); turn it on in CC Switch, then send the message again.',
      noDefault: () => 'CCSwitch has no default Codex card; select one in CC Switch, then send the message again.',
      failover: label => `${label} is only usable through CCSwitch, and CCSwitch automatic failover is on, which could switch cards silently; turn failover off in CC Switch, then send the message again.`,
      officialLogin: label => `${label} is OpenAI official and needs Codex signed in with ChatGPT (codex login).`,
      defaultChanged: (label, now) => `${label} is only usable as CCSwitch's default card, and CCSwitch's default card is now “${now}”; select ${label} again in CC Switch, or start a new conversation.`,
      notInStack: label => `${label} is no longer in CCSwitch Aggregation; add it again in CC Switch (Codex → Aggregation).`,
      cardChanged: label => `${label} was edited or removed in CCSwitch, so this conversation no longer forwards to it (it could now be another relay); a new conversation uses the edited card.`,
      unusable: label => `${label} cannot be used through ModelTrace right now; run node "${AUTOSWITCH}" check in a terminal to see why.`,
      unreadable: () => `CCSwitch's configuration cannot be read; run node "${AUTOSWITCH}" check in a terminal to see why.`,
    },
    staleConfig: 'This conversation belongs to an earlier gateway configuration; requests through the gateway will be refused. Start a new conversation.',
    outdated: `The plugin was upgraded to 0.5 and its gateway configuration needs an update: run node "${AUTOSWITCH}" connect in a terminal (the gateway address stays; new conversations then start on CCSwitch's default card), then start a new conversation. Asking Codex to “reconnect ModelTrace” also works, but this conversation ends with it.`,
    bypass: target => `This conversation does not go through the ModelTrace gateway; it actually uses ${target}. Monitoring and route switching are unavailable here. Ask Codex to reconnect ModelTrace if needed.`,
    bypassThread: target => `This conversation does not go through the ModelTrace gateway; it actually uses ${target}. Monitoring and route switching are unavailable here; new conversations go through the gateway.`,
    staleGateway: 'This conversation points at an outdated ModelTrace gateway address, so its requests will fail. Ask Codex to reconnect ModelTrace if needed.',
    targets: { card: name => `CCSwitch's current card “${name}”`, anyCard: "CCSwitch's currently selected card", chatgpt: 'OpenAI official (ChatGPT login, personal subscription)',
      openai: 'OpenAI official (current Codex login)', custom: name => `“${name}”`, unknown: 'an unrecognized route' },
  },
};
const safeName = value => (typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '?');
const ROUTE_PROBLEMS = { CCSWITCH_NOT_PROXIED: 'proxyOff', CCSWITCH_FAILOVER: 'failover', CCSWITCH_DEFAULT_CHANGED: 'defaultChanged', NOT_IN_STACK: 'notInStack' };
const savedRoute = provider => ({ transport: provider.transport, providerId: provider.id, sourceKey: provider.key, ccswitchMode: ccswitchMode(provider) });

/**
 * CCSwitch as a new conversation meets it now: its default card and the route
 * the gateway would take there (as resolveSessionRoute does), or why that card
 * cannot be used. Never throws.
 */
export async function defaultCardView(config, { inspect = inspectCCSwitch, readCards = null } = {}) {
  let layout, id;
  try { layout = await inspect(config.ccSwitchDirectory); } catch { return { layout: null, problem: 'unreadable' }; }
  try { id = defaultCardId(layout); } catch (error) { return { layout, problem: error.code === 'NO_DEFAULT_CARD' ? 'noDefault' : 'proxyOff' }; }
  const card = { id, name: safeName(layout.providers.find(provider => provider.id === id)?.name) };
  try {
    readCards ||= (await import('./direct-route.mjs')).readDirectCards;
    const provider = routeDescriptor(layout, id, (await readCards(config.ccSwitchDirectory, { id })).get(id));
    verifyRouteLayout(config, layout, savedRoute(provider));
    return { layout, card, provider };
  } catch (error) { return { layout, card, problem: ROUTE_PROBLEMS[error.code] || 'unusable' }; }
}

// Why a started conversation's route will fail now, if it does: the gateway
// reads CCSwitch on every request, refuses an edited or removed card, and a
// CCSwitch route also needs CCSwitch's current state.
function routeProblem(config, view, current) {
  if (!view.layout) return 'unreadable';
  try { assertProviderCurrent(view.layout, current); } catch { return 'cardChanged'; }
  if (current.transport !== 'ccswitch') return null;
  try { verifyRouteLayout(config, view.layout, savedRoute(current)); return null; }
  catch (error) { return error.code === 'CCSWITCH_DEFAULT_CHANGED' && !view.card ? 'noDefault' : ROUTE_PROBLEMS[error.code] || 'unusable'; }
}

/**
 * A thread routed by the gateway: its saved route, or for a brand-new thread
 * CCSwitch's current default card (`view`, from defaultCardView), with the
 * monitoring state, or the reason its requests will fail.
 */
export function gatewayNotice(text, config, state, view = {}, accountType = null) {
  const p = state?.autoSwitch;
  if ((p && p.configId !== config.id) || (!p && state?.initialRoute && state.initialRoute.configId !== config.id)) return text.prefix + text.staleConfig;
  const start = p?.primary || state?.initialRoute?.provider || null, current = p?.current || start || view.provider || null;
  const label = current && current.id === view.card?.id ? text.defaultCard(safeName(current.name))
    : current ? text.card(safeName(current.name)) : view.card ? text.defaultCard(view.card.name) : null;
  // An Official route passes the native login through, so it needs ChatGPT.
  const problem = !current ? view.problem : (start ? routeProblem(config, view, current) : null)
    || (current.transport === 'official' && accountType && !officialLogin(accountType) ? 'officialLogin' : null);
  if (problem) return text.prefix + text.failing(text.reasons[problem](label, view.card?.name || '?'));
  const official = current.transport === 'official';
  const role = official ? text.roles.official : start && current.id !== start.id ? text.roles.switched(safeName(start.name)) : text.roles.thirdParty;
  let message = text.prefix + text.route(label, role);
  if (official) message += text.official;
  else if (state?.enabled === true) message += text.on;
  else message += text.off(state?.config?.toolMin ?? DEFAULTS.toolMin, state?.config?.toolMax ?? DEFAULTS.toolMax);
  if (state?.switchRequest?.status === 'pending') message += text.pending;
  if (view.provider && current.id !== view.card.id) message += text.newConversations(view.card.name);
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

// The saved configuration predates 0.5: tell the user how to update it.
export async function outdatedNotice(env = process.env, { language = noticeLanguage } = {}) {
  const text = NOTICE_TEXT[await language(env).catch(() => 'en')];
  return text.prefix + text.outdated;
}

// Never throws: a notice must not block or fail the session it describes.
export async function startupNotice(event, directory, connection, env = process.env, {
  language = noticeLanguage, load = loadGatewayConfig, read = readState, inspect = inspectCCSwitch, readCards = null,
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
      const state = session ? await read(directory, session) : null;
      return gatewayNotice(text, config, state, await defaultCardView(config, { inspect, readCards }), connection.accountType ?? null);
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
