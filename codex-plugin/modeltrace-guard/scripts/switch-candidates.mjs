import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadGatewayConfig, routeDescriptor, verifyGatewayReady } from './provider-config.mjs';
import { readDirectCards } from './direct-route.mjs';
import { readState } from './state.mjs';
import { recordCandidates } from './switch-consent.mjs';

export const REASONS = { INVALID_PROVIDER: 'invalid_card', MANAGED_ACCOUNT: 'managed_official_account',
  OFFICIAL_NOT_NATIVE: 'official_card_not_native', NOT_IN_STACK: 'needs_ccswitch_aggregation' };
// Fixed text the agent translates for the user; never upstream or card content.
export const HINTS = {
  current_route: 'This conversation already uses it.',
  needs_ccswitch_aggregation: 'CCSwitch manages this card\'s login (for example GitHub Copilot or xAI), so only CCSwitch can use it. To use it, add it in CCSwitch: Codex → Aggregation → + on this card, then ask to refresh the list.',
  card_config_unreadable: 'CCSwitch saved a configuration for this card that cannot be read.',
  card_provider_missing: "The card's config.toml names no model_provider (or no openai_base_url), or does not define the provider it selects.",
  card_uses_profile: 'The card selects its provider through a Codex profile, which the gateway does not reproduce.',
  needs_ccswitch_conversion: 'The card does not use the Responses API (wire_api = "responses"); only CCSwitch can convert its format, so it cannot be reached directly.',
  unsupported_base_url: 'The card base_url must be https (http only on this computer) without credentials, query or fragment.',
  key_from_environment: 'The card reads its key from an environment variable, which the gateway cannot see.',
  headers_from_environment: 'The card reads headers from environment variables, which the gateway cannot see.',
  card_headers_invalid: 'The card defines a reserved or invalid header.',
  key_missing: 'The card has no key for its provider.',
  managed_official_account: 'This Official card selects another ChatGPT account managed by CCSwitch; the gateway can only use the current Codex login.',
  official_card_not_native: 'This Official card stores its own login or connection settings; only the unbound native Official card can be used.',
  card_changed: 'The card changed in CCSwitch while it was being read; ask to refresh the list.',
  ccswitch_proxy_off: "This card needs CCSwitch's local proxy for Codex; turn on Routing or Aggregation mode in CC Switch.",
  official_needs_chatgpt_login: 'OpenAI Official uses the current Codex login, which is not a ChatGPT login; sign in with ChatGPT (codex login) to use it.',
  ccswitch_failover_enabled: "This card is only usable as CCSwitch's default card, and CCSwitch automatic failover is on (it could move the conversation silently); turn failover off in CC Switch.",
  invalid_card: 'The card has no usable name or identity in CCSwitch.',
};
const OUTCOMES = new Set(['compatible', 'inconclusive', 'difference_signal', 'repeated_difference']);
const displayName = value => (typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null);

// Every CCSwitch Codex card as a possible target for one conversation, with the
// route it would take (routeDescriptor; `cards` are direct-route.mjs readings).
// Selectable cards are numbered: the recommended backup, the card this
// conversation started on, CCSwitch's current default card, Official, then the
// rest in CCSwitch order. Entries carry identity only, never credentials.
export function listCandidates(layout, config, current, history = new Map(), cards = new Map(), login = null, startId = null, monitoring = true) {
  const proxied = layout.mode === 'proxy' && layout.attached && !layout.pending;
  const entries = [];
  for (const row of layout.providers || []) {
    if (typeof row?.id !== 'string' || !row.id) continue;
    let descriptor = null, reason = null;
    try { descriptor = routeDescriptor(layout, row.id, cards.get(row.id)); }
    catch (error) { reason = error.code === 'DIRECT_UNUSABLE' ? error.problem : REASONS[error.code] || 'invalid_card'; }
    if (current && row.id === current.id) reason = 'current_route';
    else if (!reason && descriptor.transport === 'official' && login && login !== 'chatgpt') reason = 'official_needs_chatgpt_login';
    else if (!reason && descriptor.transport === 'ccswitch' && !proxied) reason = 'ccswitch_proxy_off';
    else if (!reason && descriptor.transport === 'ccswitch' && descriptor.key === null && layout.listener?.auto_failover_enabled !== 0) reason = 'ccswitch_failover_enabled';
    const official = descriptor ? descriptor.transport === 'official'
      : row.category === 'official' || row.nativeOfficial === 1 || row.managedCodexAccount === 1;
    entries.push({ id: row.id, name: descriptor?.name ?? displayName(row.name), kind: official ? 'official' : 'third_party',
      ccswitchDefault: row.id === layout.defaultProvider, sessionStart: row.id === startId,
      recommended: !reason && row.id === config.backup?.id, selectable: !reason, reason,
      monitoringAfterSwitch: official ? 'stops' : monitoring ? 'continues' : 'stays_off', lastCheck: history.get(row.id) || null,
      descriptor: reason ? null : descriptor });
  }
  const rank = entry => (entry.recommended ? 0 : entry.sessionStart ? 1 : entry.ccswitchDefault ? 2 : entry.kind === 'official' ? 3 : 4);
  const selectable = entries.filter(entry => entry.selectable).sort((a, b) => rank(a) - rank(b));
  selectable.forEach((entry, index) => { entry.number = index + 1; });
  return [...selectable, ...entries.filter(entry => !entry.selectable).map(entry => ({ ...entry, number: null }))];
}

// The latest scored sample per CCSwitch card across recent local task states,
// so the user can avoid spending a verification probe on a known mismatch.
export async function providerHistory(directory, { limit = 200 } = {}) {
  const names = (await readdir(directory).catch(() => [])).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  const dated = await Promise.all(names.map(async name => ({ name, at: (await stat(path.join(directory, name)).catch(() => null))?.mtimeMs || 0 })));
  const latest = new Map();
  for (const { name } of dated.sort((a, b) => b.at - a.at).slice(0, limit)) {
    let state;
    try { state = JSON.parse(await readFile(path.join(directory, name), 'utf8')); } catch { continue; }
    for (const sample of Array.isArray(state?.samples) ? state.samples : []) {
      const id = sample?.fork?.routing?.providerId;
      if (typeof id !== 'string' || !Number.isFinite(sample.at) || !OUTCOMES.has(sample.outcome)
        || typeof sample.expected !== 'string' || typeof sample.prediction !== 'string') continue;
      if ((latest.get(id)?.at ?? -1) < sample.at) {
        latest.set(id, { at: sample.at, expected: sample.expected, prediction: sample.prediction, outcome: sample.outcome });
      }
    }
  }
  return latest;
}

const publicEntry = ({ descriptor, ...entry }) => ({ ...entry, ...(entry.reason ? { hint: HINTS[entry.reason] } : {}) });

// `candidates`: list routes for this conversation. With --request it also binds
// the numbers to exact card identities for that incident's answer.
export async function listSwitchCandidates(directory, session, requestId = null) {
  const config = await loadGatewayConfig(directory), layout = await verifyGatewayReady(directory, config);
  const state = await readState(directory, session);
  const current = state?.autoSwitch?.current || state?.initialRoute?.provider || null;
  const startId = state?.autoSwitch?.primary?.id ?? state?.initialRoute?.provider?.id ?? null;
  // Card readings decide direct reachability only; keys stay in this process.
  const cards = await readDirectCards(config.ccSwitchDirectory);
  // Monitoring that only paused for personal Official resumes on a third-party
  // target (finishVerification); monitoring the user never enabled stays off.
  const monitoring = state?.enabled === true || state?.monitoringStoppedReason === 'personal_route';
  // A pending incident recommends its proposed target (switchControlContext);
  // after a failed verification, the target that just failed is not recommended.
  const request = requestId && state?.switchRequest?.id === requestId ? state.switchRequest : null;
  const recommendedId = request?.status === 'pending' ? request.target?.id ?? null
    : request && request.target?.id === config.backup?.id ? null : config.backup?.id ?? null;
  const recommended = { backup: recommendedId ? { id: recommendedId } : null };
  // The login recorded when the policy was enabled; approval checks the live one.
  const entries = listCandidates(layout, recommended, current, await providerHistory(directory), cards, state?.autoSwitch?.accountType ?? null,
    startId, monitoring);
  if (requestId) await recordCandidates(directory, session, requestId, entries);
  const defaultCard = layout.providers.find(provider => provider.id === layout.defaultProvider);
  return { requestId, current: current ? { id: current.id, name: current.name, kind: current.transport === 'official' ? 'official' : 'third_party' } : null,
    ccswitchDefault: defaultCard ? { id: defaultCard.id, name: displayName(defaultCard.name) } : null,
    candidates: entries.map(publicEntry), keepCurrent: current ? { number: 0, name: current.name } : null,
    instruction: requestId
      ? 'Show the selectable entries as a numbered list in the user\'s language (number, name, kind, whether monitoring stops or continues after switching, last check if any), then the unavailable ones with their hint, and 0 = keep the current route. Record the answer with choose --request <ID> --pick <N> (or --target-name), or decline-switch for 0.'
      : 'Show the selectable entries as a numbered list in the user\'s language, then the unavailable ones with their hint. Switch only after the user names one: switch-route --target-provider <id>.' };
}
