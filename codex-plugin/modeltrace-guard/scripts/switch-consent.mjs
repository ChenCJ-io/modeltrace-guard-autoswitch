import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, isMismatch, readState, record, schedule, segment, stopMonitoring, withState } from './state.mjs';
import { UUID, assertProviderCurrent, atomicJSON, describeProvider, gatewayURL, loadGatewayConfig,
  readJSON, resolveProvider, sameProvider, verifyGatewayReady, verifyRouteLayout } from './provider-config.mjs';

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
    'responseEvent', 'providerId', 'providerFingerprint', 'transport', 'sourceKey', 'ccswitchMode', 'proposalId', 'approvalId', 'challenge'];
  const safe = Object.fromEntries(allowed.filter(k => Object.hasOwn(receipt, k)).map(k => [k, receipt[k]]));
  if (receipt.challenge && receipt.success === true && receipt.completed === true) {
    await atomicJSON(probeReceiptPath(directory, receipt.threadId, receipt.challenge), { ...safe, configId: config.id });
  }
  await atomicJSON(receiptPath(directory, receipt.threadId), { ...safe, configId: config.id });
}
const routeFor = (config, provider, revision, extra = {}) => ({ route: provider.id === config.primary.id ? 'source' : 'fallback',
  revision, sourceKey: provider.key, providerId: provider.id, providerFingerprint: provider.fingerprint,
  transport: provider.transport, ccswitchMode: provider.transport === 'ccswitch' ? (provider.id === config.primary.id ? 'default' : 'stack') : null, ...extra });
const providerMatchesReceipt = (provider, receipt, primary) => receipt?.providerId === provider.id
  && receipt.providerFingerprint === provider.fingerprint && receipt.transport === provider.transport && receipt.sourceKey === provider.key
  && (provider.transport !== 'ccswitch' || receipt.ccswitchMode === (provider.id === primary.id ? 'default' : 'stack'));
const checkedRoute = (config, layout, provider, revision, extra) => {
  const route = routeFor(config, provider, revision, extra);
  verifyRouteLayout(config, layout, route);
  return route;
};

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
    });
  }
  let state = await readState(directory, thread);
  if (state?.autoSwitch) {
    const p = state.autoSwitch;
    if (!consentPolicy(state) || p.configId !== config.id) throw new Error('Thread routing policy needs explicit v0.3 reconfiguration in a new thread');
    const layout = await verifyGatewayReady(directory, config);
    assertProviderCurrent(layout, p.current);
    // Existing routes override launch's bootstrap selection after a switch.
    return checkedRoute(config, layout, p.current, p.revision);
  }
  if (!state?.initialRoute) {
    const layout = await verifyGatewayReady(directory, config);
    const provider = initialProviderId ? describeProvider(layout, initialProviderId) : config.primary;
    checkedRoute(config, layout, provider, 0);
    await withState(directory, thread, s => { s.initialRoute ||= { configId: config.id, provider }; });
    state = await readState(directory, thread);
  }
  if (state.initialRoute.configId !== config.id) throw new Error('Initial thread route belongs to an earlier configuration; launch a new thread');
  const layout = await verifyGatewayReady(directory, config);
  assertProviderCurrent(layout, state.initialRoute.provider);
  return checkedRoute(config, layout, state.initialRoute.provider, 0);
}

export async function enableAutoSwitch(directory, session, { accountType, modelProvider, model }, now = Date.now()) {
  if (!UUID.test(session) || accountType !== 'chatgpt' || modelProvider !== 'openai' || !model) {
    throw new Error('Approval-based switching requires a native ChatGPT-authenticated openai thread started through the gateway');
  }
  const config = await loadGatewayConfig(directory);
  verifyRouteLayout(config, await verifyGatewayReady(directory, config));
  if (config.primary.transport === 'official') throw new Error('The selected primary is personal Official; monitoring remains off to avoid extra inference');
  const receipt = await readReceipt(directory, session);
  if (!receipt || receipt.configId !== config.id || !receipt.success || !receipt.completed || !providerMatchesReceipt(config.primary, receipt, config.primary)
    || now - receipt.finishedAt > 10 * 60 * 1000 || receipt.finishedAt > now) {
    throw new Error('No recent successful primary request through the gateway; launch with the primary first. Personal sessions are not silently rerouted or monitored');
  }
  return withState(directory, session, state => {
    if (state.taskHalt || state.pending || state.probeRun || state.confirmation?.status === 'active') throw new Error('Finish the current monitoring checkpoint/halt before enabling');
    if (state.autoSwitch) throw new Error('This thread already has a route policy; no implicit re-arming or switch-back');
    if (state.initialRoute && !sameProvider(state.initialRoute.provider, config.primary)) throw new Error('This session was started on another provider; no implicit switch to the primary');
    state.model = state.expected = model; state.expectedSource = 'auto';
    state.enabled = true; state.startedAt ||= now; state.enabledAt = now; state.runtimePaused = false;
    state.runtimeEndedAt = null; state.monitoringStoppedReason = null;
    segment(state, now, 'approval_monitor_enabled');
    state.autoSwitch = { protocol: 3, approvalMode: 'per_incident', enabled: true, policyId: randomUUID(), configId: config.id,
      primary: config.primary, backup: config.backup, current: config.primary, phase: 'armed', route: 'source', revision: 1,
      enabledAt: now, attempts: 0, noticePending: false };
    record(state, 'approval_monitor_enabled', now, { policyId: state.autoSwitch.policyId, primary: config.primary.id, backup: config.backup.id });
    return state.autoSwitch;
  });
}

export function eligibleForSwitch(state, sample = state.samples.at(-1)) {
  const p = state.autoSwitch, r = sample?.fork?.routing;
  return Boolean(live(state) && consentPolicy(state) && p.enabled && ['armed', 'switched'].includes(p.phase)
    && p.current.transport !== 'official' && !state.taskHalt && !unresolved(state.switchRequest)
    && isMismatch(sample) && sample.epoch === state.epoch && sample.expected === state.expected
    && r?.configId === p.configId && r.policyId === p.policyId && r.revision === p.revision
    && r.success === true && r.completed === true && providerMatchesReceipt(p.current, r, p.primary));
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
  const target = state.autoSwitch.backup.id === state.autoSwitch.current.id ? null : state.autoSwitch.backup;
  proposal(state, target, { challenge: sample.challenge, expected: sample.expected, prediction: sample.prediction,
    outcome: sample.outcome, language: sample.language, at: sample.at }, now);
  return true;
}

export async function proposeSwitch(directory, session, id, selection, now = Date.now()) {
  const config = await loadGatewayConfig(directory), layout = await verifyGatewayReady(directory, config);
  const target = selection?.name || selection?.id ? resolveProvider(layout, selection) : config.backup;
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
// not cryptographic proof of a human response, and acknowledge never calls it.
export async function approveSwitch(directory, session, id, targetId, readiness, now = Date.now()) {
  const config = await loadGatewayConfig(directory), layout = await verifyGatewayReady(directory, config);
  return withState(directory, session, state => {
    const r = currentRequest(state, id);
    if (!live(state) || r.status !== 'pending' || !r.target || targetId !== r.target.id || config.id !== r.configId
      || state.pending || state.probeRun || state.alerts.some(a => !a.acknowledgedAt)) {
      throw new Error('Switch approval requires the live pending request, its exact target, and reported alerts');
    }
    if (readiness?.accountType !== 'chatgpt' || readiness.modelProvider !== 'openai' || readiness.model !== state.model) {
      throw new Error('Native login/model settings changed; approval cannot start verification');
    }
    assertProviderCurrent(layout, r.source); assertProviderCurrent(layout, r.target);
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
    language: r.evidence.language || state.config.languages[0], at: now,
    expiresAt: now + state.config.pendingSeconds * 1000, workTools: state.workTools };
  state.issued++; state.turnIssued++;
  record(state, 'switch_verification_started', now, { challenge: state.pending.id, requestId: r.id, approvalId: r.approval.id });
  return true;
}

export async function declineSwitch(directory, session, id, now = Date.now()) {
  return withState(directory, session, state => {
    const r = currentRequest(state, id);
    if (r.status !== 'pending' || state.alerts.some(a => !a.acknowledgedAt)) throw new Error('Decline requires a pending proposal with reported alerts');
    r.status = 'declined'; r.finishedAt = now;
    state.taskHalt = null; state.autoSwitch.phase = 'armed';
    state.forceProbe = false; schedule(state, now);
    record(state, 'switch_declined_keep_current', now, { requestId: r.id, providerId: state.autoSwitch.current.id });
    return r;
  });
}

export function failAutoSwitch(state, now, reason) {
  const p = state.autoSwitch;
  if (!['awaiting_approval', 'verifying', 'switch_pending'].includes(p?.phase)) return;
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
    && providerMatchesReceipt(r.target, receipt, p.primary) && sample.expected === state.taskHalt.expected
    && sample.prediction === sample.expected && sample.outcome === 'compatible';
  if (!success) { failAutoSwitch(state, now, 'approved_target_verification_failed'); return true; }
  r.status = 'succeeded'; r.finishedAt = now;
  p.current = structuredClone(r.target); p.route = p.current.id === p.primary.id ? 'source' : 'fallback';
  p.phase = 'switched'; p.revision++; p.switchedAt = now; p.noticePending = true;
  p.receipt = { requestId: receipt.requestId, threadId: receipt.threadId, finishedAt: receipt.finishedAt,
    proposalId: r.id, approvalId: r.approval.id, providerId: r.target.id, prediction: sample.prediction };
  record(state, 'autoswitch_verified', now, { haltId: state.taskHalt.id, requestId: r.id, providerId: r.target.id, approvalId: r.approval.id });
  state.taskHalt = null; state.pending = null; state.epoch++; state.forceProbe = false;
  if (!stopMonitoringOnPersonalRoute(state, now)) schedule(state, now);
  return true;
}

const quote = value => `'${String(value).replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`;
export function switchControlContext(state, directory, root) {
  const p = state.autoSwitch, r = state.switchRequest;
  if (!state.taskHalt || !r || r.haltId !== state.taskHalt.id) return null;
  const command = (verb, suffix = '') => `node ${quote(path.join(root, 'scripts', 'guard.mjs'))} ${verb}`
    + ` --session ${quote(state.session)} --data-dir ${quote(directory || '')} --request ${quote(r.id)}` + suffix;
  if (p.phase === 'awaiting_approval' && r.status === 'pending') {
    return `ModelTrace AutoSwitch: STOP original task work and ASK THE USER whether to switch from ${JSON.stringify(r.source.name)} to ${r.target ? JSON.stringify(r.target.name) : 'a user-named CCSwitch configuration'}. Explain the fingerprint candidate is uncertain, not proof of reduced capability; target verification consumes one probe before routing changes. Report and acknowledge the alert, then ask and yield for the user's answer. Do not poll, verify, approve, or switch while waiting for consent. Acknowledgement and installation are NOT switch consent.\nAfter explicit consent to the displayed target only: ${r.target ? command('approve-switch', ` --target-provider ${quote(r.target.id)}`) : 'first propose the requested named target'}.\nIf the user names another target: ${command('propose-switch', ' --target-name <exact-name>')}; approval must use the NEW request ID and target ID. If the user already explicitly said to switch to that named target, record that consent without asking redundantly.\nOnly if the user explicitly chooses to keep this provider and continue: ${command('decline-switch')}. Silence or an ambiguous answer never means consent.`;
  }
  if (p.phase === 'verifying' && r.status === 'verifying') return `ModelTrace AutoSwitch: the user approved ${JSON.stringify(r.target.name)} for this incident. Keep original task work paused while the approved target is verified. Do not clear the halt or replay work tools. Use the bounded read-only command: ${command('wait-switch')}. Continue only after autoswitch_verified; failure retains the halt and current route.`;
  return `ModelTrace AutoSwitch: switch request ${JSON.stringify(r.id)} is ${JSON.stringify(r.status)} (${JSON.stringify(r.reason || p.reason || '')}). The original route and halt remain. Tell the user; do not reuse old consent, clear the halt automatically or continue original work. For an explicit user request to try another target, use ${command('propose-switch', ' --target-name <exact-name>')} and approve its NEW request ID. If comparison conditions changed, request a new primary check after an explicit resume instead.`;
}

export async function prepareSwitchTransport(directory, snapshot, pending) {
  const state = await readState(directory, snapshot.sourceSession);
  if (!state?.autoSwitch) return null;
  if (!consentPolicy(state) || snapshot.provider !== 'openai') throw new Error('Switch probes require the v0.3 native openai consent contract');
  const config = await loadGatewayConfig(directory);
  if (config.id !== state.autoSwitch.configId) throw new Error('Switch configuration changed');
  const layout = await verifyGatewayReady(directory, config);
  const canary = pending.kind === 'fallback_verification', p = state.autoSwitch;
  const request = canary ? currentRequest(state, pending.proposalId) : null;
  if (canary && (!isVerification(state) || pending.approvalId !== request.approval?.id)) throw new Error('No live incident approval for this canary');
  const provider = canary ? request.target : p.current, revision = p.revision + (canary ? 1 : 0);
  assertProviderCurrent(layout, provider);
  const binding = { session: snapshot.sourceSession, configId: config.id, policyId: p.policyId,
    challenge: pending.id, epoch: state.epoch, provider, revision, expiresAt: pending.expiresAt,
    proposalId: request?.id || null, approvalId: request?.approval?.id || null };
  let forkId;
  return {
    mode: 'autoswitch_gateway', url: gatewayURL(config),
    async authorize(id) {
      if (!UUID.test(id) || id === snapshot.sourceSession || id === snapshot.id) throw new Error('Only disposable probe forks may be bound');
      forkId = id; await atomicJSON(bindingPath(directory, id), binding);
      await resolveSessionRoute(directory, config, id);
    },
    async receipt() {
      const deadline = Math.min(pending.expiresAt, Date.now() + 2000);
      let receipt;
      const matches = receipt => receipt && receipt.configId === config.id && receipt.threadId === forkId && receipt.revision === revision
        && providerMatchesReceipt(provider, receipt, p.primary) && receipt.challenge === pending.id
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
      return { ...receipt, policyId: p.policyId };
    },
    async close() {
      if (forkId) for (const filename of [bindingPath(directory, forkId), probeReceiptPath(directory, forkId, pending.id)]) {
        await unlink(filename).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
    },
  };
}
