import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { handleHook, run } from '../scripts/guard.mjs';
import { handleBackgroundHook, waitForConfirmation } from '../scripts/background.mjs';
import { newState, readState, sessionPath, withState } from '../scripts/state.mjs';
import { runAutoSwitch } from '../scripts/autoswitch.mjs';
import { resolveSessionRoute } from '../scripts/switch-policy.mjs';
import { atomicJSON, configureGateway, loadGatewayConfig } from '../scripts/provider-config.mjs';

const execute = promisify(execFile);
const primary = { id: 'company', name: 'API2 copy', fingerprint: '1'.repeat(64), transport: 'ccswitch', key: 'company' };
const personal = { id: 'official', name: 'OpenAI Official', fingerprint: '2'.repeat(64), transport: 'official', key: null };
const other = { id: 'other', name: 'Other Relay', fingerprint: '3'.repeat(64), transport: 'ccswitch', key: 'other' };
// Protocol 3 is the per-incident policy version; state and gateway config retain
// their separate schema versions. These represent already completed decisions,
// never an implicit upgrade of a v0.2 authorizedAt into fresh consent.
function consentPolicy(current = personal, overrides = {}) {
  return { protocol: 3, approvalMode: 'per_incident', policyId: randomUUID(), configId: randomUUID(),
    primary: structuredClone(primary), backup: structuredClone(personal), current: structuredClone(current),
    enabled: false, phase: 'switched', route: current.id === primary.id ? 'source' : 'fallback', revision: 2,
    monitoringStoppedAt: Date.now(), ...overrides };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'personal-monitoring-')), session = randomUUID();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, session };
}
const noInference = { connect: async () => assert.fail('disabled monitoring cannot start a probe') };

async function routingFixture(directory) {
  await execute('sqlite3', [path.join(directory, 'cc-switch.db'), `
    CREATE TABLE providers(id TEXT,name TEXT,category TEXT,app_type TEXT,settings_config TEXT,meta TEXT);
    INSERT INTO providers VALUES
      ('company','API2 copy',NULL,'codex','{"auth":{"OPENAI_API_KEY":"synthetic-only"},"config":""}',NULL),
      ('official','OpenAI Official','official','codex','{"auth":{},"config":""}','{"providerType":"codex_oauth"}');
    CREATE TABLE proxy_config(app_type TEXT,listen_address TEXT,listen_port INTEGER,auto_failover_enabled INTEGER DEFAULT 0);
    INSERT INTO proxy_config(app_type,listen_address,listen_port) VALUES('codex','127.0.0.1',15721);
  `]);
  await atomicJSON(path.join(directory, 'live-state.json'), { apps: { codex: {
    mode: 'proxy', attached: true, proxy_route: 'company',
    stack: { enabled: true, members: ['company'], keys: { company: 'company' } },
  } } });
  await configureGateway(directory, { primaryName: 'API2 copy', backupName: 'OpenAI Official', ccSwitchDirectory: directory });
  return loadGatewayConfig(directory);
}

test('initial personal use remains unmonitored across startup and work without per-tool state writes', async t => {
  const { directory, session } = await fixture(t);
  const config = await routingFixture(directory);
  // Personal use is an explicit bootstrap selection. An unselected thread now
  // defaults to the company primary rather than silently choosing Official.
  const initial = await resolveSessionRoute(directory, config, session, config.backup.id);
  assert.equal(initial.transport, 'official'); assert.equal(initial.providerId, config.backup.id);
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
  assert.equal(state.autoSwitch, undefined); assert.equal(state.initialRoute.provider.transport, 'official');
  assert.equal((await resolveSessionRoute(directory, config, session)).providerId, config.backup.id);
  const sibling = randomUUID(), defaultRoute = await resolveSessionRoute(directory, config, sibling);
  assert.equal(defaultRoute.providerId, config.primary.id);
  assert.equal(defaultRoute.transport, 'ccswitch');
  assert.equal((await readState(directory, sibling)).enabled, false);
});

test('v0.2.0 switched sessions stop old queued probes on upgrade and preserve unrelated halts and history', async t => {
  const { directory, session } = await fixture(t);
  const old = newState(session);
  Object.assign(old, { enabled: true, issued: 6, forceProbe: true, nextTools: 17,
    samples: [{ challenge: 'saved-evidence' }],
    pending: { id: 'old-probe', expiresAt: Date.now() + 50000 },
    autoSwitch: { enabled: true, phase: 'switched', route: 'fallback', revision: 2, policyId: 'existing-policy', authorizedAt: 123 },
    taskHalt: { id: 'later-unrelated-halt', retryCount: 3, expected: 'gpt-6-astra' } });
  await writeFile(sessionPath(directory, session), JSON.stringify(old));
  const output = await handleHook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, directory);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  const migrated = await readState(directory, session);
  assert.equal(migrated.enabled, false); assert.equal(migrated.autoSwitch.enabled, false);
  assert.equal(migrated.pending, null); assert.equal(migrated.nextTools, null); assert.equal(migrated.forceProbe, false);
  assert.equal(migrated.autoSwitch.route, 'fallback'); assert.equal(migrated.autoSwitch.revision, 2);
  assert.equal(migrated.autoSwitch.migrationRequired, true);
  assert.equal(migrated.autoSwitch.protocol, undefined);
  assert.equal(migrated.autoSwitch.approvalMode, undefined);
  assert.equal(migrated.autoSwitch.authorizedAt, old.autoSwitch.authorizedAt, 'old evidence is preserved without granting incident approval');
  assert.equal(migrated.switchRequest, undefined);
  assert.equal(migrated.monitoringStoppedReason, 'per_incident_reconfiguration_required');
  assert.deepEqual(migrated.samples, old.samples); assert.deepEqual(migrated.taskHalt, old.taskHalt);
  assert.equal(migrated.issued, old.issued);
  await withState(directory, session, () => {});
  const repeated = await readState(directory, session);
  assert.equal(repeated.events.filter(e => e.type === 'monitoring_stopped' && e.reason === 'personal_route').length, 1);
  assert.equal(repeated.events.filter(e => e.type === 'legacy_switch_consent_revoked').length, 1);
  await assert.rejects(resolveSessionRoute(directory, { id: randomUUID() }, session), /explicit v0.3 reconfiguration/);
});

test('an old in-flight automatic canary is cancelled without becoming a v0.3 approved request', async t => {
  const { directory, session } = await fixture(t), old = newState(session);
  Object.assign(old, { enabled: true, pending: { id: 'old-canary', kind: 'fallback_verification', expiresAt: Date.now() + 50000 },
    autoSwitch: { enabled: true, phase: 'verifying', route: 'source', revision: 1, authorizedAt: 123 },
    taskHalt: { id: 'old-halt', retryCount: 3, expected: 'gpt-6-astra' }, samples: [{ challenge: 'source-evidence' }] });
  await writeFile(sessionPath(directory, session), JSON.stringify(old));
  await handleBackgroundHook({ session_id: session, hook_event_name: 'PostToolUse' }, directory, {}, noInference);
  const state = await readState(directory, session);
  assert.equal(state.enabled, false); assert.equal(state.pending, null);
  assert.equal(state.autoSwitch.phase, 'failed'); assert.equal(state.autoSwitch.migrationRequired, true);
  assert.equal(state.autoSwitch.enabled, false); assert.equal(state.autoSwitch.protocol, undefined);
  assert.equal(state.switchRequest, undefined); assert.deepEqual(state.taskHalt, old.taskHalt);
  assert.deepEqual(state.samples, old.samples);
});

test('disable cancels a pending primary probe without changing its v0.3 route or erasing its alert', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.enabled = true; state.forceProbe = true; state.nextTools = 10;
    state.autoSwitch = consentPolicy(primary, { enabled: true, phase: 'armed', revision: 1, monitoringStoppedAt: undefined });
    state.pending = { id: 'company-probe', expiresAt: Date.now() + 10000 };
    state.alerts = [{ id: 'existing-alert', acknowledgedAt: 1 }];
  });
  await runAutoSwitch(['disable', '--session', session, '--data-dir', directory], {});
  const state = await readState(directory, session);
  assert.equal(state.enabled, false); assert.equal(state.autoSwitch.enabled, false); assert.equal(state.autoSwitch.route, 'source');
  assert.equal(state.autoSwitch.protocol, 3); assert.deepEqual(state.autoSwitch.current, primary);
  assert.equal(state.autoSwitch.migrationRequired, undefined);
  assert.equal(state.pending, null); assert.equal(state.forceProbe, false); assert.equal(state.nextTools, null);
  assert.equal(state.alerts[0].id, 'existing-alert'); assert.equal(state.switchRequest, undefined);
  await handleBackgroundHook({ session_id: session, hook_event_name: 'PostToolUse' }, directory, {}, noInference);
  assert.equal((await readState(directory, session)).enabled, false);
});

test('only an explicit ordinary start can resume personal diagnostics after the automatic stop', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.model = state.expected = 'gpt-6-astra';
    state.autoSwitch = consentPolicy();
    state.monitoringStoppedReason = 'personal_route';
  });
  const result = await run(['start', '--session', session, '--data-dir', directory], {});
  assert.equal(result.enabled, true); assert.ok(result.pending); assert.equal(result.monitoringStoppedReason, null);
  await withState(directory, session, () => {});
  const state = await readState(directory, session);
  assert.equal(state.enabled, true); assert.equal(state.autoSwitch.route, 'fallback'); assert.equal(state.autoSwitch.enabled, false);
  assert.deepEqual(state.autoSwitch.current, personal); assert.equal(state.autoSwitch.protocol, 3);
  assert.equal(state.autoSwitch.migrationRequired, undefined); assert.equal(state.switchRequest, undefined);
});

test('disabling during compaction still observes its completion before a later explicit diagnostic start', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.enabled = true; state.model = state.expected = 'gpt-6-astra';
    state.autoSwitch = consentPolicy(); // Explicitly running ordinary personal diagnostics.
  });
  await handleHook({ session_id: session, hook_event_name: 'PreCompact', turn_id: 'compact-turn' }, directory);
  await runAutoSwitch(['disable', '--session', session, '--data-dir', directory], {});
  assert.equal((await readState(directory, session)).compacting, true);
  await handleBackgroundHook({ session_id: session, hook_event_name: 'SessionStart', source: 'compact', turn_id: 'after-compact' }, directory, {}, noInference);
  assert.equal((await readState(directory, session)).enabled, false);
  assert.equal((await readState(directory, session)).compacting, false);
  const result = await run(['start', '--session', session, '--data-dir', directory], {});
  assert.equal(result.enabled, true); assert.ok(result.pending);
  const current = await readState(directory, session);
  assert.equal(current.autoSwitch.enabled, false); assert.deepEqual(current.autoSwitch.current, personal);
});

test('a delayed switch notification reports manually restarted diagnostics without stopping them', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.model = state.expected = 'gpt-6-astra';
    state.autoSwitch = consentPolicy(personal, { noticePending: true });
  });
  const started = await run(['start', '--session', session, '--data-dir', directory], {});
  await withState(directory, session, state => { state.probeRun = { pid: process.pid, challenge: state.pending.id }; });
  const notice = await handleBackgroundHook({ session_id: session, hook_event_name: 'PostToolUse' }, directory, {}, noInference);
  assert.match(notice.hookSpecificOutput.additionalContext, /Diagnostic monitoring is currently enabled/);
  assert.doesNotMatch(notice.hookSpecificOutput.additionalContext, /no further probes are scheduled/);
  const current = await readState(directory, session);
  assert.equal(current.enabled, true); assert.equal(current.pending.id, started.pending.id);
  assert.equal(current.autoSwitch.enabled, false); assert.deepEqual(current.autoSwitch.current, personal);
});

test('an old successful switch cannot mask alerts from explicitly restarted personal diagnostics', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.enabled = true;
    state.autoSwitch = consentPolicy(personal, { haltId: 'old-switch' });
    state.confirmation = { id: 'manual-diagnostics', status: 'active', target: 3, results: [] };
    state.alerts = [{ id: 'manual-alert', at: Date.now(), expected: 'expected', prediction: 'other', level: 'candidate_mismatch', acknowledgedAt: null }];
  });
  const waiting = await waitForConfirmation(directory, session, 'manual-diagnostics', { timeoutMs: 0 });
  assert.equal(waiting.agentAction, 'notify_user_now');
  assert.equal(waiting.enabled, true); assert.ok(waiting.notificationContext);
});

test('v0.3 personal routes stay stopped through restart, compaction and later tools without periodic probes', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.model = state.expected = 'gpt-6-astra'; state.issued = 2;
    state.autoSwitch = consentPolicy(); state.monitoringStoppedReason = 'personal_route';
  });
  for (const event of [
    { hook_event_name: 'SessionStart', source: 'resume' },
    { hook_event_name: 'UserPromptSubmit' },
    { hook_event_name: 'PreCompact' },
    { hook_event_name: 'SessionStart', source: 'compact' },
    { hook_event_name: 'Interrupt' },
    { hook_event_name: 'SessionEnd' },
    { hook_event_name: 'SessionStart', source: 'resume' },
  ]) {
    const input = { session_id: session, turn_id: 'personal-turn', ...event };
    if (['SessionStart', 'UserPromptSubmit'].includes(event.hook_event_name)) await handleBackgroundHook(input, directory, {}, noInference);
    else await handleHook(input, directory);
  }
  const before = await readFile(sessionPath(directory, session), 'utf8');
  for (let i = 0; i < 40; i++) {
    await handleHook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, directory);
    await handleBackgroundHook({ session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: `personal-${i}` }, directory, {}, noInference);
  }
  const state = await readState(directory, session);
  assert.equal(await readFile(sessionPath(directory, session), 'utf8'), before);
  assert.equal(state.enabled, false); assert.equal(state.autoSwitch.enabled, false);
  assert.equal(state.pending, null); assert.equal(state.issued, 2);
  assert.deepEqual(state.autoSwitch.current, personal); assert.equal(state.autoSwitch.protocol, 3);
  assert.equal(state.switchRequest, undefined); assert.equal(state.autoSwitch.migrationRequired, undefined);
});

test('a v0.3 third-party backup is not mistaken for a personal subscription merely because its route is fallback', async t => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, state => {
    state.enabled = true;
    state.autoSwitch = consentPolicy(other, { enabled: true, monitoringStoppedAt: undefined });
  });
  await withState(directory, session, () => {});
  const state = await readState(directory, session);
  assert.equal(state.autoSwitch.route, 'fallback'); assert.equal(state.autoSwitch.current.transport, 'ccswitch');
  assert.equal(state.enabled, true); assert.equal(state.autoSwitch.enabled, true);
  assert.equal(state.monitoringStoppedReason, undefined);
  assert.equal(state.autoSwitch.monitoringStoppedAt, undefined);
  assert.equal(state.autoSwitch.migrationRequired, undefined);
});
