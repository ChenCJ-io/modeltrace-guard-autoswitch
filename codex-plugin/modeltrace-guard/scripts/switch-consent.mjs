import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drainingRelay } from './stream-relay.mjs';
import { consumeUserReply, digest, isMismatch, readState, record, requireUserReply, sameConfusableGroup, schedule, segment, stopMonitoring, withState } from './state.mjs';
import { NATIVE_LOGINS, UUID, assertProviderCurrent, atomicJSON, ccswitchMode, defaultCardId, gatewayURL, loadGatewayConfig,
  officialLogin, readJSON, resolveProvider, routeDescriptor, sameProvider, validateProvider, verifyGatewayReady, verifyRouteLayout } from './provider-config.mjs';

const live = state => Boolean(state?.enabled && !state.runtimePaused && !state.compacting && !state.runtimeEndedAt);
const consentPolicy = state => state?.autoSwitch?.protocol === 3 && state.autoSwitch.approvalMode === 'per_incident';
const unresolved = request => ['pending', 'approved', 'verifying'].includes(request?.status);
export const isVerification = state => Boolean(consentPolicy(state) && state.autoSwitch.enabled
  && state.autoSwitch.phase === 'verifying' && state.switchRequest?.status === 'verifying'
  && state.pending?.kind === 'fallback_verification' && state.pending.proposalId === state.switchRequest.id
  && state.pending.approvalId === state.switchRequest.approval?.id);
export const isRecoveryActive = state => live(state) && isVerification(state);
export const haltBlocksProbe = state => Boolean(state?.taskHalt && !isVerification(state));
export const needsPersonalMonitoringStop = state => state?.autoSwitch?.phase === 'switched'
  && (state.autoSwitch.current?.transport === 'official'
    || (!consentPolicy(state) && state.autoSwitch.route === 'fallback'))
  && state.autoSwitch.monitoringStoppedAt == null;

// v0.2's blanket authorizedAt must never become approval of a v0.3 incident.
export function invalidateLegacyConsent(state, now) {
  const p = state.autoSwitch;
  if (!p || consentPolicy(state) || p.migrationRequired) return false;
  p.enabled = false; p.migrationRequired = true;
  if (['switch_pending', 'verifying'].includes(p.phase)) {
    p.phase = 'failed'; p.reason = 'per_incident_reconfiguration_required';
  }
  if (state.pending?.kind === 'fallback_verification') state.pending = null;
  stopMonitoring(state, now, 'per_incident_reconfiguration_required');
  record(state, 'legacy_switch_consent_revoked', now);
  return true;
}

const receiptPath = (directory, thread) => path.join(directory, '_receipts', `${digest(thread)}.json`);
// A late failed retry/compaction must not overwrite the completed inference
// receipt a native probe is waiting for. Each challenge has its own success slot.
const probeReceiptPath = (directory, thread, challenge) => path.join(directory, '_receipts', `${digest(`${thread}:${challenge}`)}.json`);
const bindingPath = (directory, thread) => path.join(directory, '_bindings', `${digest(thread)}.json`);
export const readReceipt = (directory, thread) => readJSON(receiptPath(directory, thread));
export async function saveReceipt(directory, config, receipt) {
  if (!UUID.test(receipt.threadId)) return;
  const allowed = ['threadId', 'requestId', 'route', 'revision', 'statusCode', 'startedAt', 'finishedAt', 'completed', 'success',
    'responseEvent', 'providerId', 'providerFingerprint', 'transport', 'sourceKey', 'ccswitchMode', 'proposalId', 'approvalId', 'challenge',
    'transportError', 'networkSource'];
  const safe = Object.fromEntries(allowed.filter(k => Object.hasOwn(receipt, k)).map(k => [k, receipt[k]]));
  if (receipt.challenge && receipt.success === true && receipt.completed === true) {
    await atomicJSON(probeReceiptPath(directory, receipt.threadId, receipt.challenge), { ...safe, configId: config.id });
  }
  await atomicJSON(receiptPath(directory, receipt.threadId), { ...safe, configId: config.id });
}
// A conversation's 'source' is the card it started on.
const routeFor = (startId, provider, revision, extra = {}) => ({ route: provider.id === startId ? 'source' : 'fallback',
  revision, sourceKey: provider.key, providerId: provider.id, providerFingerprint: provider.fingerprint,
  transport: provider.transport, ccswitchMode: ccswitchMode(provider), ...extra });
const providerMatchesReceipt = (provider, receipt) => receipt?.providerId === provider.id
  && receipt.providerFingerprint === provider.fingerprint && receipt.transport === provider.transport && receipt.sourceKey === provider.key
  && (provider.transport !== 'ccswitch' || receipt.ccswitchMode === ccswitchMode(provider));
const checkedRoute = (config, layout, provider, revision, extra, startId) => {
  const route = routeFor(startId, provider, revision, extra);
  verifyRouteLayout(config, layout, route);
  return route;
};
// The route for a named card, including whether it can be reached directly.
async function cardRoute(config, layout, id) {
  const { readDirectCards } = await import('./direct-route.mjs');
  return routeDescriptor(layout, id, (await readDirectCards(config.ccSwitchDirectory, { id })).get(id));
}
const selectedRoute = (config, layout, selection) => cardRoute(config, layout, resolveProvider(layout, selection).id);
// The route a new conversation takes now (CCSwitch's default card), checked as
// its first request would be. Nothing is written.
export async function newThreadRoute(config, layout) {
  const provider = await cardRoute(config, layout, defaultCardId(layout));
  checkedRoute(config, layout, provider, 0, {}, provider.id);
  return provider;
}

// The thread still runs the same native model through openai, signed in; an
// Official target also needs the ChatGPT login it passes through. Checked
// before the user's reply is consumed, so a refusal leaves it unused.
function assertReadiness(readiness, state, target, action) {
  if (!NATIVE_LOGINS.includes(readiness?.accountType) || readiness.modelProvider !== 'openai' || readiness.model !== state.model) {
    throw new Error(`Native login/model settings changed; ${action}`);
  }
  if (target?.transport === 'official' && !officialLogin(readiness.accountType)) {
    throw Object.assign(new Error('OpenAI Official needs Codex signed in with ChatGPT (codex login); nothing was approved'), { code: 'OFFICIAL_NEEDS_CHATGPT_LOGIN' });
  }
}

function currentRequest(state, id, { allowFailed = false } = {}) {
  const p = state.autoSwitch, r = state.switchRequest;
  if (!consentPolicy(state) || !p.enabled || !r || r.id !== id || !(unresolved(r) || (allowFailed && r.status === 'failed'))
    || state.taskHalt?.id !== r.haltId || state.epoch !== r.epoch || p.policyId !== r.policyId
    || p.configId !== r.configId || p.revision !== r.revision || !sameProvider(p.current, r.source)) {
    throw new Error('No matching live switch request; old consent cannot authorize this incident');
  }
  return r;
}

export async function resolveSessionRoute(directory, config, thread, initialProviderId) {
  if (!UUID.test(thread)) throw new Error('A native thread-id is required');
  const binding = await readJSON(bindingPath(directory, thread));
  if (binding) {
    if (binding.expiresAt <= Date.now() || binding.configId !== config.id) throw new Error('Probe route binding expired or changed');
    const state = await readState(directory, binding.session), p = state?.autoSwitch;
    if (binding.initial) {
      // A thread without a route policy (standalone monitoring) is probed on
      // the card it started on, never on CCSwitch's current default card.
      if (!live(state) || p || state.pending?.id !== binding.challenge || state.epoch !== binding.epoch
        || state.initialRoute?.configId !== config.id || !sameProvider(state.initialRoute.provider, binding.provider) || binding.revision !== 0) {
        throw new Error('Probe route binding no longer belongs to a live checkpoint');
      }
      const layout = await verifyGatewayReady(directory, config);
      assertProviderCurrent(layout, binding.provider);
      return checkedRoute(config, layout, binding.provider, 0, { challenge: binding.challenge }, binding.provider.id);
    }
    if (!live(state) || !consentPolicy(state) || state.pending?.id !== binding.challenge
      || state.epoch !== binding.epoch || p?.policyId !== binding.policyId || p.configId !== config.id) {
      throw new Error('Probe route binding no longer belongs to a live checkpoint');
    }
    if (binding.approvalId) {
      const r = currentRequest(state, binding.proposalId);
      if (!isVerification(state) || r.approval?.id !== binding.approvalId || !sameProvider(binding.provider, r.target)
        || binding.revision !== p.revision + 1) throw new Error('Probe switch approval has been revoked or changed');
    } else if (state.taskHalt || !sameProvider(binding.provider, p.current) || binding.revision !== p.revision) {
      throw new Error('Probe source route changed');
    }
    const layout = await verifyGatewayReady(directory, config);
    assertProviderCurrent(layout, binding.provider);
    return checkedRoute(config, layout, binding.provider, binding.revision, {
      proposalId: binding.proposalId, approvalId: binding.approvalId, challenge: binding.challenge,
    }, p.primary.id);
  }
  let state = await readState(directory, thread);
  if (state?.autoSwitch) {
    const p = state.autoSwitch;
    if (!consentPolicy(state) || p.configId !== config.id) throw new Error('Thread routing policy needs explicit v0.3 reconfiguration in a new thread');
    const layout = await verifyGatewayReady(directory, config);
    assertProviderCurrent(layout, p.current);
    // Existing routes override launch's bootstrap selection after a switch.
    return checkedRoute(config, layout, p.current, p.revision, {}, p.primary.id);
  }
  if (!state?.initialRoute) {
    // A new conversation starts on CCSwitch's current default card and stays on
    // it: a later change of CCSwitch's default only affects newer conversations.
    // An explicit launch choice replaces the default card.
    const layout = await verifyGatewayReady(directory, config);
    let provider;
    if (initialProviderId) {
      provider = await cardRoute(config, layout, initialProviderId);
      checkedRoute(config, layout, provider, 0, {}, provider.id);
    } else provider = await newThreadRoute(config, layout);
    await withState(directory, thread, s => { s.initialRoute ||= { configId: config.id, provider }; });
    state = await readState(directory, thread);
  }
  if (state.initialRoute.configId !== config.id) throw new Error('Initial thread route belongs to an earlier configuration; start a new conversation');
  const layout = await verifyGatewayReady(directory, config);
  assertProviderCurrent(layout, state.initialRoute.provider);
  return checkedRoute(config, layout, state.initialRoute.provider, 0, {}, state.initialRoute.provider.id);
}

// What a route policy needs, read outside the state lock: the card this thread
// started on under the current configuration, still usable, and a recent
// successful request of this thread on it (just written receipts get a moment).
async function policyStart(directory, session, { accountType, modelProvider, model }, monitor, now) {
  if (!UUID.test(session) || !NATIVE_LOGINS.includes(accountType) || modelProvider !== 'openai' || !model) {
    throw new Error('Route switching needs a signed-in native openai thread started through the gateway');
  }
  const config = await loadGatewayConfig(directory), layout = await verifyGatewayReady(directory, config);
  const start = (await readState(directory, session))?.initialRoute;
  if (!start || start.configId !== config.id) {
    throw new Error('This thread has no gateway route under the current configuration; start a new conversation after connecting');
  }
  assertProviderCurrent(layout, start.provider);
  verifyRouteLayout(config, layout, routeFor(start.provider.id, start.provider, 1));
  if (monitor && start.provider.transport === 'official') throw new Error('This thread uses the personal Official route; monitoring remains off to avoid extra inference');
  const fresh = receipt => receipt && receipt.configId === config.id && receipt.success && receipt.completed && providerMatchesReceipt(start.provider, receipt)
    && now - receipt.finishedAt <= 10 * 60 * 1000 && receipt.finishedAt <= Date.now();
  const deadline = Date.now() + 1000;
  let receipt = await readReceipt(directory, session);
  while (!fresh(receipt) && Date.now() < deadline) { await delay(25); receipt = await readReceipt(directory, session); }
  if (!fresh(receipt)) {
    throw new Error('No recent successful request of this thread through the gateway; send a message in this conversation first. Sessions are never silently rerouted or monitored');
  }
  return { config, start: start.provider };
}

// Creates the policy inside the state lock, after policyStart.
function attachPolicy(state, { config, start }, { accountType, model }, monitor, now) {
  if (state.autoSwitch) throw new Error('This thread already has a route policy');
  if (!state.initialRoute || !sameProvider(state.initialRoute.provider, start)) throw new Error('This thread\'s route changed; send a message and try again');
  state.model = state.expected = model; state.expectedSource = 'auto';
  state.enabled = monitor; state.startedAt ||= now; state.enabledAt = now; state.runtimePaused = false;
  state.runtimeEndedAt = null; state.monitoringStoppedReason = monitor ? null : 'routing_only';
  if (monitor) segment(state, now, 'approval_monitor_enabled');
  state.autoSwitch = { protocol: 3, approvalMode: 'per_incident', enabled: true, policyId: randomUUID(), configId: config.id, accountType,
    primary: start, backup: config.backup, current: start, phase: 'armed', route: 'source', revision: 1,
    enabledAt: now, attempts: 0, noticePending: false, ...(monitor ? {} : { monitoringStoppedAt: now }) };
  record(state, monitor ? 'approval_monitor_enabled' : 'route_policy_enabled', now,
    { policyId: state.autoSwitch.policyId, start: start.id, backup: config.backup?.id ?? null });
  return state.autoSwitch;
}

/**
 * The thread's route policy, starting from the card it started on (its
 * `primary` in policy terms). With `monitor`, fingerprint monitoring starts too;
 * without it the thread only gains in-conversation route switching (requested
 * switches still verify their target once). Either way it needs a recent
 * successful request of this thread through the gateway.
 */
export async function enableAutoSwitch(directory, session, readiness, { monitor = true } = {}, now = Date.now()) {
  const prepared = await policyStart(directory, session, readiness, monitor, now);
  return withState(directory, session, state => {
    if (state.taskHalt || state.pending || state.probeRun || state.confirmation?.status === 'active') throw new Error('Finish the current monitoring checkpoint/halt before enabling');
    return attachPolicy(state, prepared, readiness, monitor, now);
  });
}

// "开启指纹监测" on a thread that already switches routes (or stopped
// monitoring): monitor its current route, unless that is personal Official.
export async function resumeMonitoring(directory, session, { accountType, modelProvider, model }, now = Date.now()) {
  if (!NATIVE_LOGINS.includes(accountType) || modelProvider !== 'openai' || !model) throw new Error('Monitoring needs a signed-in native openai thread');
  const config = await loadGatewayConfig(directory);
  return withState(directory, session, state => {
    const p = state.autoSwitch;
    if (!consentPolicy(state) || p.configId !== config.id) throw new Error('This thread has no route policy for the current gateway configuration; start a new conversation');
    if (state.enabled) return p;
    if (p.current.transport === 'official') throw new Error('This thread uses the personal Official route; monitoring remains off to avoid extra inference');
    if (state.taskHalt || unresolved(state.switchRequest) || state.pending || state.probeRun) throw new Error('Settle the open incident or switch before turning monitoring on');
    state.model = state.expected = model; state.expectedSource = 'auto';
    state.enabled = true; state.monitoringStoppedReason = null; state.runtimePaused = false; state.runtimeEndedAt = null;
    p.enabled = true; p.monitoringStoppedAt = null;
    // A settled failed or disabled request must not keep later incidents from asking.
    if (!['armed', 'switched'].includes(p.phase)) p.phase = 'armed';
    segment(state, now, 'monitoring_resumed');
    record(state, 'monitoring_resumed', now, { policyId: p.policyId, providerId: p.current.id });
    return p;
  });
}

export function eligibleForSwitch(state, sample = state.samples.at(-1)) {
  const p = state.autoSwitch, r = sample?.fork?.routing;
  return Boolean(live(state) && consentPolicy(state) && p.enabled && ['armed', 'switched'].includes(p.phase)
    && p.current.transport !== 'official' && !state.taskHalt && !unresolved(state.switchRequest)
    && isMismatch(sample) && sample.epoch === state.epoch && sample.expected === state.expected
    && r?.configId === p.configId && r.policyId === p.policyId && r.revision === p.revision
    && r.success === true && r.completed === true && providerMatchesReceipt(p.current, r));
}

function proposal(state, target, evidence, now) {
  const p = state.autoSwitch;
  const request = { id: randomUUID(), haltId: state.taskHalt.id, status: 'pending', createdAt: now,
    configId: p.configId, policyId: p.policyId, epoch: state.epoch, revision: p.revision,
    source: structuredClone(p.current), target: target ? structuredClone(target) : null,
    evidence: structuredClone(evidence), approval: null };
  state.switchRequest = request;
  Object.assign(p, { phase: 'awaiting_approval', haltId: request.haltId });
  record(state, 'switch_consent_requested', now, { requestId: request.id, haltId: request.haltId, targetProvider: target?.id || null });
  return request;
}

export function queueAutoSwitch(state, now, sample = state.samples.at(-1)) {
  if (!eligibleForSwitch(state, sample)) return false;
  state.taskHalt = { id: sample.challenge, at: now, expected: sample.expected, retryCount: 0,
    predictions: [sample.prediction], alertId: sample.challenge, reason: 'switch_consent_required' };
  // The configured backup is only the recommended target; the user may pick any listed card.
  const backup = state.autoSwitch.backup;
  const target = backup && backup.id !== state.autoSwitch.current.id ? backup : null;
  proposal(state, target, { challenge: sample.challenge, expected: sample.expected, prediction: sample.prediction,
    outcome: sample.outcome, language: sample.language, at: sample.at }, now);
  return true;
}

export async function proposeSwitch(directory, session, id, selection, now = Date.now()) {
  const config = await loadGatewayConfig(directory), layout = await verifyGatewayReady(directory, config);
  const target = selection?.name || selection?.id ? await selectedRoute(config, layout, selection) : config.backup;
  if (!target) throw new Error('No recommended backup is configured; list the candidates and let the user choose a target');
  return withState(directory, session, state => {
    const old = currentRequest(state, id, { allowFailed: true });
    if (!live(state) || !['pending', 'failed'].includes(old.status) || state.pending || state.probeRun) throw new Error('Only a pending or settled failed proposal may change target');
    if (config.id !== old.configId || sameProvider(target, old.source)) throw new Error('Choose a different provider from the current route');
    assertProviderCurrent(layout, old.source);
    record(state, 'switch_proposal_replaced', now, { requestId: old.id });
    return proposal(state, target, old.evidence, now);
  });
}

// This command records the agent/CLI's report of explicit user consent. It is
// not cryptographic proof of what the user said, and acknowledge never calls
// it; it does require that the user actually replied after the report.
export async function approveSwitch(directory, session, id, targetId, readiness, now = Date.now()) {
  const config = await loadGatewayConfig(directory), layout = await verifyGatewayReady(directory, config);
  return withState(directory, session, state => {
    const r = currentRequest(state, id);
    if (!live(state) || r.status !== 'pending' || !r.target || targetId !== r.target.id || config.id !== r.configId
      || state.pending || state.probeRun || state.alerts.some(a => !a.acknowledgedAt)) {
      throw new Error('Switch approval requires the live pending request, its exact target, and reported alerts');
    }
    assertReadiness(readiness, state, r.target, 'approval cannot start verification');
    assertProviderCurrent(layout, r.source); assertProviderCurrent(layout, r.target);
    verifyRouteLayout(config, layout, routeFor(state.autoSwitch.primary.id, r.target, state.autoSwitch.revision + 1));
    consumeUserReply(state, 'Switch approval');
    r.approval = { id: randomUUID(), requestId: r.id, haltId: r.haltId, providerId: r.target.id, fingerprint: r.target.fingerprint,
      configId: r.configId, policyId: r.policyId, revision: r.revision, approvedAt: now, recordedBy: 'agent_reported_user_consent' };
    r.status = 'approved';
    if (!beginVerification(state, now)) throw new Error('Approved verification could not be queued');
    record(state, 'switch_user_consent_recorded', now, { requestId: r.id, approvalId: r.approval.id, providerId: r.target.id });
    return r;
  });
}

export function beginVerification(state, now) {
  const p = state.autoSwitch, r = state.switchRequest;
  if (!consentPolicy(state) || !p.enabled || !live(state) || p.phase !== 'awaiting_approval' || r?.status !== 'approved'
    || !r.approval || r.approval.requestId !== r.id || r.approval.providerId !== r.target?.id
    || r.approval.fingerprint !== r.target?.fingerprint || state.pending || state.probeRun
    || state.alerts.some(a => !a.acknowledgedAt)) return false;
  try { currentRequest(state, r.id); } catch { return false; }
  r.status = 'verifying'; p.phase = 'verifying'; p.attempts++; p.verificationStartedAt = now;
  state.pending = { id: randomUUID(), kind: 'fallback_verification', proposalId: r.id, approvalId: r.approval.id,
    epoch: state.epoch, model: state.model, expected: state.expected, count: 300,
    language: r.evidence?.language || state.config.languages[0], at: now,
    expiresAt: now + state.config.pendingSeconds * 1000, workTools: state.workTools };
  state.issued++; state.turnIssued++;
  record(state, 'switch_verification_started', now, { challenge: state.pending.id, requestId: r.id, approvalId: r.approval.id });
  return true;
}

export async function declineSwitch(directory, session, id, now = Date.now()) {
  return withState(directory, session, state => {
    const r = currentRequest(state, id);
    if (r.status !== 'pending' || state.alerts.some(a => !a.acknowledgedAt)) throw new Error('Decline requires a pending proposal with reported alerts');
    consumeUserReply(state, 'Declining the switch');
    r.status = 'declined'; r.finishedAt = now;
    state.taskHalt = null; state.autoSwitch.phase = 'armed';
    state.forceProbe = false; schedule(state, now);
    record(state, 'switch_declined_keep_current', now, { requestId: r.id, providerId: state.autoSwitch.current.id });
    return r;
  });
}

// Bind the numbers shown to the user to exact card identities for this request.
// A later answer is resolved against this snapshot, never by name or position.
export async function recordCandidates(directory, session, id, entries, now = Date.now()) {
  return withState(directory, session, state => {
    const r = currentRequest(state, id, { allowFailed: true });
    if (!['pending', 'failed'].includes(r.status)) throw new Error('Candidates can only be listed for a pending or settled failed request');
    r.candidates = { listedAt: now, entries: entries.filter(entry => entry.selectable && entry.descriptor)
      .map(({ number, descriptor }) => ({ number, ...validateProvider(structuredClone(descriptor)) })) };
    record(state, 'switch_candidates_listed', now, { requestId: r.id, count: r.candidates.entries.length });
    return r.candidates;
  });
}

function listedTarget(request, pick) {
  const entry = request?.candidates?.entries?.find(item => item.number === pick);
  if (!entry) throw new Error(`Choice ${pick} was not listed for this request; list the candidates again and ask the user`);
  const { number, ...descriptor } = entry;
  return validateProvider(structuredClone(descriptor));
}

// The target an answer refers to, resolved before taking the state lock (for
// example to check Official reachability). chooseSwitchTarget re-resolves it.
export async function previewChoice(directory, session, id, selection) {
  if (selection.pick == null) return resolveSwitchTarget(directory, selection);
  const state = await readState(directory, session);
  return listedTarget(state?.switchRequest?.id === id ? state.switchRequest : null, selection.pick);
}

/**
 * The user's answer to an incident: a listed number or a named card. One
 * reply selects the target and records consent for it, then starts the same
 * verification as approve-switch. Choosing another card than the proposed one
 * replaces the proposal with a new request ID; nothing is inherited from it.
 */
export async function chooseSwitchTarget(directory, session, id, selection, readiness, now = Date.now()) {
  const config = await loadGatewayConfig(directory), layout = await verifyGatewayReady(directory, config);
  const named = selection.pick == null ? await selectedRoute(config, layout, selection) : null;
  return withState(directory, session, state => {
    const old = currentRequest(state, id, { allowFailed: true });
    if (!live(state) || !['pending', 'failed'].includes(old.status) || state.pending || state.probeRun) {
      throw new Error('Only a pending or settled failed request can take the user\'s choice');
    }
    if (config.id !== old.configId) throw new Error('Gateway configuration changed; old consent cannot authorize this incident');
    if (state.alerts.some(a => !a.acknowledgedAt)) throw new Error('Report and acknowledge pending alerts before recording the user\'s choice');
    const target = named || listedTarget(old, selection.pick);
    // A card edited after it was listed needs a fresh list and a fresh answer.
    assertProviderCurrent(layout, target); assertProviderCurrent(layout, old.source);
    if (sameProvider(target, old.source) || target.id === old.source.id) throw new Error('Choose a different provider from the current route');
    // A CCSwitch route needs CCSwitch's current state (default card, Aggregation).
    verifyRouteLayout(config, layout, routeFor(state.autoSwitch.primary.id, target, state.autoSwitch.revision + 1));
    assertReadiness(readiness, state, target, 'approval cannot start verification');
    consumeUserReply(state, 'Switch approval');
    let r = old;
    if (old.status !== 'pending' || !sameProvider(target, old.target)) {
      record(state, 'switch_proposal_replaced', now, { requestId: old.id });
      r = proposal(state, target, old.evidence, now);
      if (old.candidates) r.candidates = structuredClone(old.candidates);
    }
    r.approval = { id: randomUUID(), requestId: r.id, haltId: r.haltId, providerId: target.id, fingerprint: target.fingerprint,
      configId: r.configId, policyId: r.policyId, revision: r.revision, approvedAt: now, recordedBy: 'agent_reported_user_choice' };
    r.status = 'approved';
    if (!beginVerification(state, now)) throw new Error('Approved verification could not be queued');
    record(state, 'switch_user_choice_recorded', now, { requestId: r.id, approvalId: r.approval.id, providerId: target.id,
      ...(selection.pick != null ? { pick: selection.pick } : {}) });
    return r;
  });
}

export async function resolveSwitchTarget(directory, selection) {
  const config = await loadGatewayConfig(directory), layout = await verifyGatewayReady(directory, config);
  return selectedRoute(config, layout, selection);
}

/**
 * A route change the user asked for in the conversation ("切到 API2 copy").
 * Their own message is the consent for this one target; consumeUserReply makes
 * sure such a message exists, so the agent cannot start a switch by itself.
 * The same canary as an incident (completed route receipt + compatible
 * fingerprint) runs before routing changes, so switching back to a relay that
 * still serves another model fails instead of silently landing on it. Failure
 * keeps the current route, releases the pause and restores monitoring.
 */
export async function requestManualSwitch(directory, session, selection, readiness, now = Date.now()) {
  const config = await loadGatewayConfig(directory), layout = await verifyGatewayReady(directory, config);
  const target = await selectedRoute(config, layout, selection);
  // Switching does not require monitoring: a thread without a policy gains one
  // for routing only, and monitoring stays off after the switch. That policy is
  // created only once every check below has passed, so a refused request
  // leaves the thread as it was.
  const standalone = 'This conversation runs standalone monitoring (guard start); stop it with guard stop, or turn on monitoring with use, before switching routes';
  const existing = await readState(directory, session);
  let prepared = null;
  if (!existing?.autoSwitch) {
    requireUserReply(existing, 'A route switch');
    if (existing?.enabled) throw new Error(standalone);
    prepared = await policyStart(directory, session, readiness, false, now);
  }
  return withState(directory, session, state => {
    const policy = state.autoSwitch;
    if (!policy && !prepared) throw new Error('This thread changed while the switch was prepared; ask again');
    if (!policy && state.enabled) throw new Error(standalone);
    if (policy && (!consentPolicy(state) || policy.configId !== config.id)) throw new Error('This thread has no route policy for the current gateway configuration; start a new conversation');
    const current = policy ? policy.current : prepared.start, startId = policy ? policy.primary.id : current.id, revision = policy ? policy.revision : 1;
    if (state.taskHalt || unresolved(state.switchRequest)) throw new Error('An incident or switch request is still open; settle it with propose-switch, approve-switch, decline-switch or an explicit resume first');
    if (state.pending || state.probeRun || state.compacting || state.runtimeEndedAt || state.runtimePaused || state.confirmation?.status === 'active') {
      throw new Error('A monitoring checkpoint is in progress; retry the switch after it completes');
    }
    if (state.alerts.some(a => !a.acknowledgedAt)) throw new Error('Report and acknowledge pending alerts before switching');
    if (sameProvider(target, current)) throw new Error(`This thread already uses ${JSON.stringify(target.name)}`);
    // A new routing-only policy takes this model label; an existing one must still match it.
    assertReadiness(readiness, policy ? state : { model: readiness.model }, target, 'the switch cannot start verification');
    assertProviderCurrent(layout, current); assertProviderCurrent(layout, target);
    // A CCSwitch route needs CCSwitch's current state (default card, Aggregation).
    verifyRouteLayout(config, layout, routeFor(startId, target, revision + 1));
    consumeUserReply(state, 'A route switch');
    const p = policy || attachPolicy(state, prepared, readiness, false, now);
    const previous = { phase: p.phase, enabled: state.enabled, autoSwitchEnabled: p.enabled,
      monitoringStoppedReason: state.monitoringStoppedReason ?? null, monitoringStoppedAt: p.monitoringStoppedAt ?? null };
    // The single canary needs live monitoring; a later Official success stops it
    // again, and failure restores exactly this previous state.
    state.enabled = true; state.monitoringStoppedReason = null;
    p.enabled = true; p.monitoringStoppedAt = null;
    const haltId = randomUUID();
    state.taskHalt = { id: haltId, at: now, expected: state.expected, retryCount: 0, predictions: [], reason: 'manual_switch_verification' };
    const request = { id: randomUUID(), kind: 'manual', haltId, status: 'approved', createdAt: now,
      configId: p.configId, policyId: p.policyId, epoch: state.epoch, revision: p.revision,
      source: structuredClone(p.current), target: structuredClone(target), evidence: null, previous, approval: null };
    request.approval = { id: randomUUID(), requestId: request.id, haltId, providerId: target.id, fingerprint: target.fingerprint,
      configId: p.configId, policyId: p.policyId, revision: p.revision, approvedAt: now, recordedBy: 'user_requested_switch' };
    state.switchRequest = request;
    Object.assign(p, { phase: 'awaiting_approval', haltId });
    record(state, 'manual_switch_requested', now, { requestId: request.id, from: request.source.id, providerId: target.id });
    if (!beginVerification(state, now)) throw new Error('The switch verification could not be queued');
    return request;
  });
}

function failManualSwitch(state, now, reason) {
  const p = state.autoSwitch, r = state.switchRequest, previous = r.previous || {};
  Object.assign(r, { status: 'failed', finishedAt: now, reason });
  Object.assign(p, { phase: previous.phase || 'armed', failedAt: now, reason, noticePending: true, haltId: null,
    enabled: previous.autoSwitchEnabled ?? p.enabled, monitoringStoppedAt: previous.monitoringStoppedAt ?? null });
  if (state.taskHalt?.id === r.haltId) state.taskHalt = null;
  if (state.pending?.kind === 'fallback_verification' && state.pending.proposalId === r.id) state.pending = null;
  if (previous.enabled === false) {
    state.enabled = false; state.forceProbe = false; state.nextTools = null; state.nextAt = null;
    state.monitoringStoppedReason = previous.monitoringStoppedReason;
  }
  record(state, 'manual_switch_failed', now, { reason, requestId: r.id, providerId: r.target.id, keptProvider: p.current.id });
}

export function failAutoSwitch(state, now, reason) {
  const p = state.autoSwitch;
  if (!['awaiting_approval', 'verifying', 'switch_pending'].includes(p?.phase)) return;
  if (state.switchRequest?.kind === 'manual' && unresolved(state.switchRequest)) return failManualSwitch(state, now, reason);
  Object.assign(p, { phase: 'failed', failedAt: now, reason });
  if (unresolved(state.switchRequest)) Object.assign(state.switchRequest, { status: 'failed', finishedAt: now, reason });
  record(state, 'autoswitch_failed', now, { reason, haltId: p.haltId, requestId: state.switchRequest?.id });
}

export function stopMonitoringOnPersonalRoute(state, now) {
  if (!needsPersonalMonitoringStop(state)) return false;
  stopMonitoring(state, now, 'personal_route');
  state.autoSwitch.enabled = false; state.autoSwitch.monitoringStoppedAt = now;
  return true;
}

export function finishVerification(state, sample, checkpoint, now) {
  if (checkpoint.kind !== 'fallback_verification') return false;
  const p = state.autoSwitch, r = state.switchRequest, receipt = sample.fork?.routing;
  let valid = false;
  try { currentRequest(state, checkpoint.proposalId); valid = true; } catch {}
  const success = valid && live(state) && p.phase === 'verifying' && r.status === 'verifying'
    && checkpoint.epoch === state.epoch && checkpoint.approvalId === r.approval?.id
    && receipt?.success === true && receipt.completed === true && receipt.configId === p.configId
    && receipt.policyId === p.policyId && receipt.revision === p.revision + 1
    && receipt.proposalId === r.id && receipt.approvalId === r.approval.id && receipt.challenge === checkpoint.id
    && providerMatchesReceipt(r.target, receipt) && sample.expected === state.taskHalt.expected
    && sample.outcome === 'compatible' && (sample.prediction === sample.expected || sameConfusableGroup(sample));
  if (!success) { failAutoSwitch(state, now, 'approved_target_verification_failed'); return true; }
  r.status = 'succeeded'; r.finishedAt = now;
  p.current = structuredClone(r.target); p.route = p.current.id === p.primary.id ? 'source' : 'fallback';
  p.phase = 'switched'; p.revision++; p.switchedAt = now; p.noticePending = true;
  p.receipt = { requestId: receipt.requestId, threadId: receipt.threadId, finishedAt: receipt.finishedAt,
    proposalId: r.id, approvalId: r.approval.id, providerId: r.target.id, prediction: sample.prediction };
  record(state, 'autoswitch_verified', now, { haltId: state.taskHalt.id, requestId: r.id, providerId: r.target.id, approvalId: r.approval.id });
  state.taskHalt = null; state.pending = null; state.epoch++; state.forceProbe = false;
  // Switching never starts monitoring on its own: monitoring the user never
  // enabled (or disabled) stays off on any route. Monitoring that only paused
  // for personal Official resumes on a third-party route.
  if (r.kind === 'manual' && r.previous?.enabled === false && r.previous.monitoringStoppedReason !== 'personal_route') {
    stopMonitoring(state, now, r.previous.monitoringStoppedReason || 'routing_only'); p.monitoringStoppedAt = now;
  } else if (!stopMonitoringOnPersonalRoute(state, now)) schedule(state, now);
  return true;
}

const quote = value => `'${String(value).replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`;
export function switchControlContext(state, directory, root) {
  const p = state.autoSwitch, r = state.switchRequest;
  if (!state.taskHalt || !r || r.haltId !== state.taskHalt.id) return null;
  const command = (verb, suffix = '') => `node ${quote(path.join(root, 'scripts', 'guard.mjs'))} ${verb}`
    + ` --session ${quote(state.session)} --data-dir ${quote(directory || '')} --request ${quote(r.id)}` + suffix;
  if (p.phase === 'awaiting_approval' && r.status === 'pending') {
    const recommended = r.target ? ` Mark ${JSON.stringify(r.target.name)} as recommended; a bare yes/同意 means that entry only.`
      : ' Nothing is recommended; a bare yes/同意 is ambiguous unless exactly one entry is selectable.';
    return `ModelTrace AutoSwitch: STOP original task work and ASK THE USER which route this conversation should use; it currently uses ${JSON.stringify(r.source.name)}. Explain the fingerprint candidate is uncertain, not proof of reduced capability. Report and acknowledge the alert, then list the routes with ${command('candidates')} and show them in the user's language as a numbered list: each selectable entry's number, name, kind, whether monitoring stops (Official, which uses the current Codex login and its subscription) or continues after switching, and its last check if any; then the unavailable entries with their reason and how to fix it; and 0 = keep ${JSON.stringify(r.source.name)} and continue.${recommended} The chosen route is verified with one probe before the switch. Ask, then yield for the user's answer: choices are accepted only after the user's next message (or a request_user_input answer) that follows the acknowledgement. Do not poll, verify or switch while waiting. Acknowledgement and installation are NOT switch consent.\nFor a listed number: ${command('choose', ' --pick <N>')}; for a card name: ${command('choose', ' --target-name <exact-name>')}. This records consent for that one target and starts its verification; continue with the returned request ID. If the user added a card in CCSwitch and asks to refresh, list the candidates again.\nOnly if the user answers 0 or explicitly keeps the current route: ${command('decline-switch')}. Silence or an ambiguous answer never means consent.`;
  }
  if (p.phase === 'verifying' && r.status === 'verifying' && r.kind === 'manual') return `ModelTrace AutoSwitch: the user asked to switch this thread from ${JSON.stringify(r.source.name)} to ${JSON.stringify(r.target.name)}. Its fingerprint and route are being verified with one probe before routing changes. Keep original task work paused; do not replay work tools. Use the bounded read-only command: ${command('wait-switch')}. On autoswitch_verified, report the new route; on failure the thread keeps ${JSON.stringify(r.source.name)}, the pause is released, and you report the reason.`;
  if (p.phase === 'verifying' && r.status === 'verifying') return `ModelTrace AutoSwitch: the user approved ${JSON.stringify(r.target.name)} for this incident. Keep original task work paused while the approved target is verified. Do not clear the halt or replay work tools. Use the bounded read-only command: ${command('wait-switch')}. Continue only after autoswitch_verified; failure retains the halt and current route.`;
  return `ModelTrace AutoSwitch: switch request ${JSON.stringify(r.id)} is ${JSON.stringify(r.status)} (${JSON.stringify(r.reason || p.reason || '')}). The original route and halt remain. Tell the user; do not reuse old consent, clear the halt automatically or continue original work. For an explicit user request to try another target, list the routes again with ${command('candidates')} and record the user's answer with ${command('choose', ' --pick <N>')}; it creates a NEW request ID. If comparison conditions changed, request a new check of the current route after an explicit resume instead.`;
}

// The probe fork is bound to the route the source thread uses: its policy's
// current route (or an approved target), or, for a thread monitored without a
// route policy, the card it started on. A thread that never went through the
// gateway keeps its own provider (null).
export async function prepareSwitchTransport(directory, snapshot, pending) {
  const state = await readState(directory, snapshot.sourceSession);
  const p = state?.autoSwitch;
  if (!p && !state?.initialRoute) return null;
  if ((p && !consentPolicy(state)) || snapshot.provider !== 'openai') throw new Error('Switch probes require the v0.3 native openai consent contract');
  const config = await loadGatewayConfig(directory);
  if (config.id !== (p ? p.configId : state.initialRoute.configId)) throw new Error('Switch configuration changed');
  const layout = await verifyGatewayReady(directory, config);
  const canary = pending.kind === 'fallback_verification';
  if (canary && !p) throw new Error('No live incident approval for this canary');
  const request = canary ? currentRequest(state, pending.proposalId) : null;
  if (canary && (!isVerification(state) || pending.approvalId !== request.approval?.id)) throw new Error('No live incident approval for this canary');
  const provider = canary ? request.target : p ? p.current : state.initialRoute.provider;
  const revision = p ? p.revision + (canary ? 1 : 0) : 0;
  assertProviderCurrent(layout, provider);
  const binding = { session: snapshot.sourceSession, configId: config.id, policyId: p?.policyId ?? null,
    challenge: pending.id, epoch: state.epoch, provider, revision, expiresAt: pending.expiresAt,
    proposalId: request?.id || null, approvalId: request?.approval?.id || null, ...(p ? {} : { initial: true }) };
  let forkId;
  // The fork talks to a local relay that keeps reading the gateway response to
  // EOF. Native Codex stops reading at response.completed and the probe closes
  // its app-server right after the turn; without the relay, a trailing upstream
  // end-of-stream (seen with Official through a proxy) leaves the gateway
  // receipt incomplete although the answer arrived.
  const relay = await drainingRelay(new URL(gatewayURL(config)));
  return {
    mode: 'autoswitch_gateway', url: relay.url,
    async authorize(id) {
      if (!UUID.test(id) || id === snapshot.sourceSession || id === snapshot.id) throw new Error('Only disposable probe forks may be bound');
      forkId = id; await atomicJSON(bindingPath(directory, id), binding);
      await resolveSessionRoute(directory, config, id);
    },
    async receipt() {
      // The relay is still draining; allow the trailing stream end to arrive.
      const deadline = Math.min(pending.expiresAt, Date.now() + 10000);
      let receipt;
      const matches = receipt => receipt && receipt.configId === config.id && receipt.threadId === forkId && receipt.revision === revision
        && providerMatchesReceipt(provider, receipt) && receipt.challenge === pending.id
        && receipt.proposalId === binding.proposalId && receipt.approvalId === binding.approvalId
        && receipt.startedAt >= pending.at && receipt.success === true && receipt.completed === true;
      do {
        receipt = await readJSON(probeReceiptPath(directory, forkId, pending.id));
        if (matches(receipt)) break;
        await delay(Math.max(1, Math.min(25, deadline - Date.now())));
      } while (Date.now() < deadline);
      if (!matches(receipt)) {
        throw new Error('No completed successful gateway receipt for this exact approved/native probe');
      }
      await resolveSessionRoute(directory, config, forkId);
      return { ...receipt, policyId: p?.policyId ?? null };
    },
    // Read before close() deletes the per-fork files, so a failed probe keeps
    // the gateway's status/transport evidence instead of only "probe_failed".
    // Receipts are published just after the response, so allow a short wait.
    async lastAttempt() {
      if (!forkId) return null;
      const deadline = Date.now() + 1000;
      let receipt;
      while (!(receipt = await readJSON(receiptPath(directory, forkId))) && Date.now() < deadline) await delay(25);
      if (!receipt || receipt.threadId !== forkId || receipt.configId !== config.id) return null;
      return { statusCode: Number.isInteger(receipt.statusCode) ? receipt.statusCode : null, completed: receipt.completed === true,
        success: receipt.success === true, responseEvent: receipt.responseEvent ?? null, transport: receipt.transport ?? null,
        transportError: receipt.transportError ?? null, networkSource: receipt.networkSource ?? null };
    },
    async close() {
      await relay.close();
      // A disposable fork never routes again; keep no per-fork files behind.
      if (forkId) for (const filename of [bindingPath(directory, forkId), receiptPath(directory, forkId), probeReceiptPath(directory, forkId, pending.id)]) {
        await unlink(filename).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
    },
  };
}
