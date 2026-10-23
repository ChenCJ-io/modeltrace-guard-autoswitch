import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describeProvider, loadGatewayConfig, verifyGatewayReady } from './provider-config.mjs';
import { readState } from './state.mjs';
import { recordCandidates } from './switch-consent.mjs';

const REASONS = { INVALID_PROVIDER: 'invalid_card', MANAGED_ACCOUNT: 'managed_official_account',
  OFFICIAL_NOT_NATIVE: 'official_card_not_native', NOT_IN_STACK: 'not_in_ccswitch_stack' };
// Fixed text the agent translates for the user; never upstream or card content.
const HINTS = {
  current_route: 'This conversation already uses it.',
  not_in_ccswitch_stack: 'Not added to CCSwitch Aggregation yet. In CCSwitch open Codex → Aggregation and click + on this card, then ask to refresh the list.',
  managed_official_account: 'This Official card selects another ChatGPT account managed by CCSwitch; the gateway can only use the current Codex login.',
  official_card_not_native: 'This Official card stores its own login or connection settings; only the unbound native Official card can be used.',
  primary_default_changed: "CCSwitch's default card is no longer the primary; make the primary CCSwitch's default card first.",
  ccswitch_failover_enabled: 'Turn off CCSwitch automatic failover before switching back to the primary.',
  invalid_card: 'The card has no usable name or identity in CCSwitch.',
};
const OUTCOMES = new Set(['compatible', 'inconclusive', 'difference_signal', 'repeated_difference']);
const displayName = value => (typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null);

// Every CCSwitch Codex card as a possible target for one conversation. Selectable
// cards are numbered: the recommended backup, the primary, Official, then the
// rest in CCSwitch order. Entries carry identity only, never credentials.
export function listCandidates(layout, config, current, history = new Map()) {
  const entries = [];
  for (const row of layout.providers || []) {
    if (typeof row?.id !== 'string' || !row.id) continue;
    let descriptor = null, reason = null;
    try { descriptor = describeProvider(layout, row.id); }
    catch (error) { reason = REASONS[error.code] || 'invalid_card'; }
    if (current && row.id === current.id) reason = 'current_route';
    else if (!reason && row.id === config.primary.id) {
      if (layout.defaultProvider !== config.primary.id) reason = 'primary_default_changed';
      else if (layout.listener?.auto_failover_enabled !== 0) reason = 'ccswitch_failover_enabled';
    }
    const official = descriptor ? descriptor.transport === 'official'
      : row.category === 'official' || row.nativeOfficial === 1 || row.managedCodexAccount === 1;
    entries.push({ id: row.id, name: descriptor?.name ?? displayName(row.name),
      kind: official ? 'official' : 'third_party', primary: row.id === config.primary.id,
      recommended: !reason && row.id === config.backup?.id, selectable: !reason, reason,
      monitoringAfterSwitch: official ? 'stops' : 'continues', lastCheck: history.get(row.id) || null,
      descriptor: reason ? null : descriptor });
  }
  const rank = entry => (entry.recommended ? 0 : entry.primary ? 1 : entry.kind === 'official' ? 2 : 3);
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
  const current = state?.autoSwitch?.current || state?.initialRoute?.provider || config.primary;
  const entries = listCandidates(layout, config, current, await providerHistory(directory));
  if (requestId) await recordCandidates(directory, session, requestId, entries);
  return { requestId, current: { id: current.id, name: current.name, kind: current.transport === 'official' ? 'official' : 'third_party' },
    candidates: entries.map(publicEntry), keepCurrent: { number: 0, name: current.name },
    instruction: requestId
      ? 'Show the selectable entries as a numbered list in the user\'s language (number, name, kind, whether monitoring stops or continues after switching, last check if any), then the unavailable ones with their hint, and 0 = keep the current route. Record the answer with choose --request <ID> --pick <N> (or --target-name), or decline-switch for 0.'
      : 'Show the selectable entries as a numbered list in the user\'s language, then the unavailable ones with their hint. Switch only after the user names one: switch-route --target-provider <id>.' };
}
