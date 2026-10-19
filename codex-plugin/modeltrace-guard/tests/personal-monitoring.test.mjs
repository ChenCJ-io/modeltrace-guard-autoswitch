import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleHook, run } from '../scripts/guard.mjs';
import { handleBackgroundHook, waitForConfirmation } from '../scripts/background.mjs';
import { newState, readState, sessionPath, withState } from '../scripts/state.mjs';
import { runAutoSwitch } from '../scripts/autoswitch.mjs';
import { resolveSessionRoute } from '../scripts/switch-policy.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'personal-monitoring-')), session = randomUUID();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, session };
}
const noInference = { connect: async () => assert.fail('disabled monitoring cannot start a probe') };

test('initial personal use remains unmonitored across startup and work without per-tool state writes', async t => {
  const { directory, session } = await fixture(t);
  const config = { id: randomUUID(), sourceKey: 'company' };
  assert.equal((await resolveSessionRoute(directory, config, session)).route, 'fallback');
  await handleBackgroundHook({ session_id: session, hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-6-astra' }, directory, {}, noInference);
  const before = await readFile(sessionPath(directory, session), 'utf8');
  for (let i = 0; i < 40; i++) {
    await handleHook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, directory);
    await handleBackgroundHook({ session_id: session, hook_event_name: 'PostToolUse', tool_use_id: `tool-${i}`, tool_name: 'Bash' }, directory, {}, noInference);
  }
  assert.deepEqual(await handleHook({ session_id: session, hook_event_name: 'Stop' }, directory), {});
  assert.equal(await readFile(sessionPath(directory, session), 'utf8'), before);
  const state = await readState(directory, session);
  assert.equal(state.enabled, false); assert.equal(state.issued, 0); assert.equal(state.pending, null);
  assert.equal((await resolveSessionRoute(directory, config, session)).route, 'fallback');
});

test('v0.2.0 switched sessions stop old queued probes on upgrade and preserve unrelated halts and history', async t => {
  const { directory, session } = await fixture(t);
  const old = newState(session);
  Object.assign(old, { enabled: true, issued: 6, forceProbe: true, nextTools: 17,
    samples: [{ challenge: 'saved-evidence' }],
    pending: { id: 'old-probe', expiresAt: Date.now() + 50000 },
    autoSwitch: { enabled: true, phase: 'switched', route: 'fallback', revision: 2, policyId: 'existing-policy' },
    taskHalt: { id: 'later-unrelated-halt', retryCount: 3, expected: 'gpt-6-astra' } });
  await writeFile(sessionPath(directory, session), JSON.stringify(old));
  const output = await handleHook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, directory);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  const migrated = await readState(directory, session);
  assert.equal(migrated.enabled, false); assert.equal(migrated.autoSwitch.enabled, false);
  assert.equal(migrated.pending, null); assert.equal(migrated.nextTools, null); assert.equal(migrated.forceProbe, false);
  assert.equal(migrated.autoSwitch.route, 'fallback'); assert.equal(migrated.autoSwitch.revision, 2);
  assert.deepEqual(migrated.samples, old.samples); assert.deepEqual(migrated.taskHalt, old.taskHalt);
  assert.equal(migrated.issued, old.issued);
  await withState(directory, session, () => {});
  assert.equal((await readState(directory, session)).events.filter(e => e.type === 'monitoring_stopped' && e.reason === 'personal_route').length, 1);
});

test('disable cancels a source retry without changing the source route or erasing its alert', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.enabled = true; state.forceProbe = true; state.nextTools = 10;
    state.autoSwitch = { enabled: true, phase: 'armed', route: 'source', revision: 1 };
    state.confirmation = { id: 'source-batch', status: 'active', results: [] };
    state.pending = { id: 'retry', confirmationId: 'source-batch', expiresAt: Date.now() + 10000 };
    state.alerts = [{ id: 'existing-alert', acknowledgedAt: 1 }];
  });
  await runAutoSwitch(['disable', '--session', session, '--data-dir', directory], {});
  const state = await readState(directory, session);
  assert.equal(state.enabled, false); assert.equal(state.autoSwitch.enabled, false); assert.equal(state.autoSwitch.route, 'source');
  assert.equal(state.pending, null); assert.equal(state.forceProbe, false); assert.equal(state.nextTools, null);
  assert.equal(state.confirmation.status, 'interrupted'); assert.equal(state.alerts[0].id, 'existing-alert');
  await handleBackgroundHook({ session_id: session, hook_event_name: 'PostToolUse' }, directory, {}, noInference);
  assert.equal((await readState(directory, session)).enabled, false);
});

test('only an explicit ordinary start can resume personal diagnostics after the automatic stop', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.model = state.expected = 'gpt-6-astra';
    state.autoSwitch = { enabled: false, phase: 'switched', route: 'fallback', revision: 2, monitoringStoppedAt: Date.now() };
    state.monitoringStoppedReason = 'personal_route';
  });
  const result = await run(['start', '--session', session, '--data-dir', directory], {});
  assert.equal(result.enabled, true); assert.ok(result.pending); assert.equal(result.monitoringStoppedReason, null);
  await withState(directory, session, () => {});
  const state = await readState(directory, session);
  assert.equal(state.enabled, true); assert.equal(state.autoSwitch.route, 'fallback'); assert.equal(state.autoSwitch.enabled, false);
});

test('disabling during compaction still observes its completion before a later explicit diagnostic start', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => { state.enabled = true; state.model = state.expected = 'gpt-6-astra'; });
  await handleHook({ session_id: session, hook_event_name: 'PreCompact', turn_id: 'compact-turn' }, directory);
  await runAutoSwitch(['disable', '--session', session, '--data-dir', directory], {});
  assert.equal((await readState(directory, session)).compacting, true);
  await handleBackgroundHook({ session_id: session, hook_event_name: 'SessionStart', source: 'compact', turn_id: 'after-compact' }, directory, {}, noInference);
  assert.equal((await readState(directory, session)).enabled, false);
  assert.equal((await readState(directory, session)).compacting, false);
  const result = await run(['start', '--session', session, '--data-dir', directory], {});
  assert.equal(result.enabled, true); assert.ok(result.pending);
});

test('a delayed switch notification reports manually restarted diagnostics without stopping them', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.model = state.expected = 'gpt-6-astra';
    state.autoSwitch = { enabled: false, phase: 'switched', route: 'fallback', revision: 2, monitoringStoppedAt: Date.now(), noticePending: true };
  });
  const started = await run(['start', '--session', session, '--data-dir', directory], {});
  await withState(directory, session, state => { state.probeRun = { pid: process.pid, challenge: state.pending.id }; });
  const notice = await handleBackgroundHook({ session_id: session, hook_event_name: 'PostToolUse' }, directory, {}, noInference);
  assert.match(notice.hookSpecificOutput.additionalContext, /Diagnostic monitoring is currently enabled/);
  assert.doesNotMatch(notice.hookSpecificOutput.additionalContext, /no further probes are scheduled/);
  const current = await readState(directory, session);
  assert.equal(current.enabled, true); assert.equal(current.pending.id, started.pending.id);
});

test('an old successful switch cannot mask alerts from explicitly restarted personal diagnostics', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.enabled = true;
    state.autoSwitch = { enabled: false, phase: 'switched', route: 'fallback', haltId: 'old-switch', monitoringStoppedAt: Date.now() };
    state.confirmation = { id: 'manual-diagnostics', status: 'active', target: 3, results: [] };
    state.alerts = [{ id: 'manual-alert', at: Date.now(), expected: 'expected', prediction: 'other', level: 'candidate_mismatch', acknowledgedAt: null }];
  });
  const waiting = await waitForConfirmation(directory, session, 'manual-diagnostics', { timeoutMs: 0 });
  assert.equal(waiting.agentAction, 'notify_user_now');
  assert.equal(waiting.enabled, true); assert.ok(waiting.notificationContext);
});
