import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, handleHook, loadArtifacts, run } from '../scripts/guard.mjs';
import { handleBackgroundHook, waitForSwitch } from '../scripts/background.mjs';
import { readState, sessionPath, withState } from '../scripts/state.mjs';
import {
  atomicJSON, approveSwitch, configPath, configureGateway, enableAutoSwitch, loadGatewayConfig,
  readReceipt, resolveSessionRoute, saveReceipt, verifyGatewayRoute,
} from '../scripts/switch-policy.mjs';
import { startSwitchGateway } from '../scripts/switch-gateway.mjs';

// These arrays are deliberately synthetic classifier fixtures. They validate
// orchestration, never model identity. All HTTP requests terminate at a local
// fake CCSwitch; no Codex process, account, credentials or real model is used.
const sampleText = (count, value) => JSON.stringify(Array(count).fill(value));
const execute = promisify(execFile);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'isolated workflow did not reach the expected state');
    await delay(5);
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoswitch-flow-'));
  const session = randomUUID(), sibling = randomUUID();
  const { bank, analyzeGlobalOutputs } = await loadArtifacts();
  const expected = analyzeGlobalOutputs([{ text: sampleText(300, 7), expected_count: 300 }], bank).results[0];
  const source = analyzeGlobalOutputs([{ text: sampleText(300, 1), expected_count: 300 }], bank).results;
  assert.ok(expected.probability >= 0.5);
  assert.notEqual(source[0].model, expected.model);
  assert.ok(source[0].probability >= 0.8);
  assert.ok(source.find(row => row.model === expected.model).probability <= 0.15);

  const counts = new Map(), upstreamRequests = [], nativeCalls = [], bases = [], forks = [];
  const originalHistory = [{ id: 'original-turn', status: 'completed', goal: 'Keep the original task unchanged' }];
  const historyBefore = structuredClone(originalHistory);
  const fallbackStarted = deferred(), releaseFallback = deferred();
  let holdFallback = false, fallbackValue = 7, clientsClosed = 0, gateway, config;
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), threadId = req.headers['thread-id'];
    const route = req.url.startsWith('/backend-api/codex/') ? 'fallback' : 'source';
    assert.equal(body.model, expected.model, 'primary and Official retain the native model ID');
    upstreamRequests.push({ threadId, route, model: body.model });
    if (route === 'fallback' && holdFallback) {
      fallbackStarted.resolve();
      await releaseFallback.promise;
    }
    if (res.destroyed) return;
    const text = sampleText(counts.get(threadId) || 300, route === 'source' ? 1 : fallbackValue);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
      status: 'completed', model: body.model,
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    } })}\n\n`);
  });
  t.after(async () => {
    releaseFallback.resolve();
    await gateway?.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('autoswitch-flow-'));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  await atomicJSON(path.join(directory, 'live-state.json'), { apps: { codex: {
    mode: 'proxy', attached: true, proxy_route: 'fixture-api2',
    stack: { enabled: true, members: ['fixture-api2'], keys: { api2: 'fixture-api2' } },
  } } });
  await execute('sqlite3', [path.join(directory, 'cc-switch.db'), `
    CREATE TABLE providers(id TEXT,name TEXT,category TEXT,app_type TEXT,settings_config TEXT,meta TEXT);
    INSERT INTO providers VALUES
      ('fixture-api2','API2',NULL,'codex','{"auth":{"OPENAI_API_KEY":"synthetic-fixture-only"},"config":""}',NULL),
      ('fixture-official','Official','official','codex','{"auth":{},"config":""}',NULL);
    CREATE TABLE proxy_config(app_type TEXT,listen_address TEXT,listen_port INTEGER,auto_failover_enabled INTEGER);
    INSERT INTO proxy_config VALUES('codex','127.0.0.1',${upstreamPort},0);
  `]);
  await configureGateway(directory, { sourceProvider: 'fixture-api2', fallbackProvider: 'fixture-official',
    ccSwitchDirectory: directory, port: upstreamPort === 15722 ? 15723 : 15722 });
  config = await loadGatewayConfig(directory);
  gateway = await startSwitchGateway({ upstream: config.upstream, token: config.token,
    verifyReady: route => verifyGatewayRoute(directory, config, route),
    resolveRoute: (thread, initial) => resolveSessionRoute(directory, config, thread, initial),
    officialRequestImpl: (target, { method, headers }, callback) => {
      assert.equal(target.origin, 'https://chatgpt.com');
      return httpRequest(`http://127.0.0.1:${upstreamPort}${target.pathname}`, { method, headers, agent: false }, callback);
    },
    onReceipt: async receipt => {
      // Exercise the real race: response completion precedes receipt publication.
      await delay(25);
      await saveReceipt(directory, config, receipt);
    },
  });
  config.port = gateway.port;
  await atomicJSON(configPath(directory), config);

  async function request(threadId) {
    const response = await fetch(`${gateway.url}/responses`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'thread-id': threadId },
      body: JSON.stringify({ model: expected.model, stream: true, input: [{ role: 'user', content: 'Synthetic workflow fixture' }] }),
    });
    assert.equal(response.status, 200);
    const event = JSON.parse((await response.text()).trim().slice('data: '.length));
    return event.response.output[0].content[0].text;
  }
  await request(session);
  await until(async () => (await readReceipt(directory, session))?.success);
  await enableAutoSwitch(directory, session, { accountType: 'chatgpt', modelProvider: 'openai', model: expected.model });

  const meta = { model: expected.model, modelProvider: 'openai', reasoningEffort: 'high', cwd: directory };
  const threads = new Map([[session, { id: session, path: path.join(directory, 'original.jsonl'), ...meta }]]);
  const dependencies = {
    connect: async () => {
      let closed = false;
      return { listeners: new Set(), async request(method, params) {
        nativeCalls.push({ method, params: structuredClone(params) });
        if (method === 'thread/read') return { thread: threads.get(params.threadId) };
        if (method === 'thread/turns/list') return { data: structuredClone(originalHistory), nextCursor: null };
        assert.equal(method, 'thread/fork');
        assert.ok(threads.has(params.threadId));
        const id = randomUUID(), thread = { id, path: params.ephemeral ? null : path.join(directory, `${id}.jsonl`),
          ephemeral: !!params.ephemeral, forkedFromId: params.threadId, ...meta };
        threads.set(id, thread);
        if (params.ephemeral) forks.push(id); else bases.push(id);
        return { thread, ...meta, serviceTier: 'default', instructionSources: [] };
      }, async close() { if (!closed) { closed = true; clientsClosed++; } } };
    },
    enforceTrust: async () => {}, // Trust behavior has separate native-protocol tests.
    generate: async (_client, forkId, pending, isCancelled) => {
      assert.equal(await isCancelled(), false);
      assert.ok(forks.includes(forkId));
      counts.set(forkId, pending.count);
      return { text: await request(forkId) };
    },
  };
  const event = () => ({ session_id: session, turn_id: 'fixture-turn', hook_event_name: 'PostToolUse',
    tool_name: 'exec_command', tool_input: { cmd: `node '${ROOT}/scripts/guard.mjs' acknowledge --alert fixture` } });
  const state = () => readState(directory, session);
  const background = () => handleBackgroundHook(event(), directory, {}, dependencies);
  async function acknowledge() {
    const current = await state(), alert = current.alerts.find(row => !row.acknowledgedAt);
    assert.ok(alert);
    return run(['acknowledge', '--data-dir', directory, '--session', session, '--alert', alert.id], {});
  }
  async function approve() {
    const current = await state();
    return approveSwitch(directory, session, current.switchRequest.id, current.switchRequest.target.id,
      { accountType: 'chatgpt', modelProvider: 'openai', model: expected.model });
  }
  async function reachHalt() {
    await background();
    const current = await state();
    assert.equal(current.confirmation, null, 'incident consent replaces automatic retry batches');
    assert.equal(current.autoSwitch.phase, 'awaiting_approval');
    assert.equal(current.switchRequest.status, 'pending');
    assert.equal(current.switchRequest.approval, null);
    assert.ok(current.taskHalt);
    assert.equal(current.forkSnapshot, null, 'the anomaly snapshot is released before user consent');
    assert.equal(bases.length, 1); assert.equal(forks.length, 1);
    assert.ok(current.samples.every(row => row.fork.routing.route === 'source' && row.fork.routing.success));
    return current;
  }
  return { directory, session, sibling, state, background, acknowledge, approve, reachHalt, request,
    bases, forks, nativeCalls, upstreamRequests, originalHistory, historyBefore, clientsClosed: () => clientsClosed,
    holdFallback() { holdFallback = true; }, fallbackStarted: fallbackStarted.promise,
    releaseFallback: () => releaseFallback.resolve(), mismatchFallback() { fallbackValue = 1; } };
}

test('first mismatch asks, acknowledgement spends no backup quota, and explicit consent verifies and switches this thread', async t => {
  const f = await fixture(t), halted = await f.reachHalt();
  const acknowledged = await f.acknowledge();
  assert.equal(acknowledged.agentAction, 'ask_user_to_switch');
  assert.equal((await f.state()).pending, null);
  await f.background();
  assert.equal(f.forks.length, 1, 'ack and background hooks must not run a target probe');
  assert.equal(f.upstreamRequests.filter(row => row.route === 'fallback').length, 0);
  await assert.rejects(waitForSwitch(f.directory, f.session, halted.switchRequest.id), /Ask the user and yield/);
  const stopped = await handleHook({ session_id: f.session, turn_id: 'fixture-turn', hook_event_name: 'Stop' }, f.directory);
  assert.equal(stopped.decision, undefined, 'the consent question must yield to the user');
  await f.approve();
  assert.equal((await f.state()).pending.kind, 'fallback_verification');
  f.holdFallback();
  const worker = f.background();
  await f.fallbackStarted;
  let waitFinished = false;
  const waiting = waitForSwitch(f.directory, f.session, halted.switchRequest.id, { timeoutMs: 3000, pollMs: 5 })
    .then(result => { waitFinished = true; return result; });
  await delay(30);
  assert.equal(waitFinished, false, 'verification is awaited while the canary is still running');
  assert.ok((await f.state()).taskHalt);
  f.releaseFallback();
  const [notice, result] = await Promise.all([worker, waiting]);
  const current = await f.state();
  assert.equal(result.agentAction, 'autoswitch_verified');
  assert.equal(current.autoSwitch.phase, 'switched');
  assert.equal(current.autoSwitch.route, 'fallback');
  assert.equal(current.autoSwitch.revision, 2);
  assert.equal(current.enabled, false); assert.equal(current.autoSwitch.enabled, false);
  assert.equal(current.monitoringStoppedReason, 'personal_route');
  assert.equal(current.pending, null); assert.equal(current.nextTools, null); assert.equal(current.forceProbe, false);
  assert.equal(current.taskHalt, null);
  assert.equal(current.probeRun, null);
  assert.equal(current.forkSnapshot, null);
  assert.equal(current.samples.at(-1).outcome, 'compatible');
  assert.equal(current.samples.at(-1).fork.routing.threadId, f.forks.at(-1));
  assert.equal(f.bases.length, 2);
  assert.equal(new Set([...f.bases, ...f.forks, f.session]).size, 5);
  assert.equal(f.clientsClosed(), 2);
  assert.match(notice.hookSpecificOutput.additionalContext, /verification completed successfully/);
  assert.deepEqual(f.originalHistory, f.historyBefore);
  await f.request(f.session);
  await f.request(f.sibling);
  assert.deepEqual(f.upstreamRequests.slice(-2).map(row => [row.threadId, row.route]), [[f.session, 'fallback'], [f.sibling, 'source']]);
  assert.equal((await readState(f.directory, f.sibling)).autoSwitch, undefined, 'another thread never acquires this policy');
  // Even a new runtime, user turn or many work completions must not spend
  // further personal-subscription inference after the one verification.
  for (const hook of ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'SessionStart']) {
    await handleBackgroundHook({ session_id: f.session, hook_event_name: hook,
      source: hook === 'SessionStart' ? 'resume' : undefined, turn_id: 'personal-turn' }, f.directory, {}, {
      connect: async () => assert.fail('personal monitoring must not open an inference runtime'),
    });
  }
  const bytes = await readFile(sessionPath(f.directory, f.session), 'utf8');
  for (let i = 0; i < 40; i++) {
    await handleHook({ session_id: f.session, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, f.directory);
    assert.deepEqual(await f.background(), {});
  }
  assert.equal(await readFile(sessionPath(f.directory, f.session), 'utf8'), bytes, 'settled disabled hooks are read-only');
  assert.equal((await f.state()).issued, 2); assert.equal(f.forks.length, 2);
  assert.equal((await f.state()).autoSwitch.route, 'fallback');
});

test('a completed fallback request with an incompatible fingerprint retains the original halt and source route', async t => {
  const f = await fixture(t), halted = await f.reachHalt();
  f.mismatchFallback();
  await f.acknowledge();
  await f.approve();
  await f.background();
  const result = await waitForSwitch(f.directory, f.session, halted.switchRequest.id, { timeoutMs: 0 });
  const current = await f.state();
  assert.equal(result.agentAction, 'stop_and_notify_user');
  assert.equal(current.autoSwitch.phase, 'failed');
  assert.equal(current.autoSwitch.route, 'source');
  assert.equal(current.taskHalt.id, halted.taskHalt.id);
  assert.equal(current.samples.at(-1).fork.routing.success, true);
  assert.notEqual(current.samples.at(-1).outcome, 'compatible');
  assert.equal(current.probeRun, null);
  assert.equal(current.forkSnapshot, null);
  assert.deepEqual(f.originalHistory, f.historyBefore);
});

test('Interrupt during a fallback request prevents a later successful receipt from clearing the halt', async t => {
  const f = await fixture(t), halted = await f.reachHalt();
  await f.acknowledge();
  await f.approve();
  f.holdFallback();
  const worker = f.background();
  await f.fallbackStarted;
  await handleHook({ session_id: f.session, turn_id: 'fixture-turn', hook_event_name: 'Interrupt' }, f.directory);
  f.releaseFallback();
  await worker;
  const result = await waitForSwitch(f.directory, f.session, halted.switchRequest.id, { timeoutMs: 0 });
  const current = await f.state();
  assert.equal(result.agentAction, 'stop_and_notify_user');
  assert.equal(current.autoSwitch.phase, 'failed');
  assert.equal(current.autoSwitch.route, 'source');
  assert.equal(current.runtimePaused, true);
  assert.equal(current.taskHalt.id, halted.taskHalt.id);
  assert.equal(current.samples.length, 1, 'an interrupted canary is not scored');
  assert.equal(current.pending, null);
  assert.equal(current.probeRun, null);
  assert.equal(current.forkSnapshot, null);
  assert.deepEqual(f.originalHistory, f.historyBefore);
});

test('a busy Stop still blocks once for fallback verification without clearing the halt or creating a continuation loop', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoswitch-flow-busy-')), session = randomUUID();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await withState(directory, session, state => {
    state.enabled = true;
    state.taskHalt = { id: 'halt', expected: 'fixture-model', retryCount: 3 };
    state.confirmation = { id: 'halt', status: 'completed', target: 3, results: [] };
    state.autoSwitch = { protocol: 3, approvalMode: 'per_incident', enabled: true, phase: 'verifying', haltId: 'halt' };
    state.switchRequest = { id: 'request', status: 'verifying', haltId: 'halt', target: { name: 'Official' }, approval: { id: 'approval' } };
    state.pending = { id: 'canary', kind: 'fallback_verification', proposalId: 'request', approvalId: 'approval', expiresAt: Date.now() + 30000 };
  });
  await writeFile(sessionPath(directory, session) + '.lock', JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() }));
  const event = { session_id: session, hook_event_name: 'Stop' };
  const first = await handleHook(event, directory);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /approved target is verified/);
  const repeated = await handleHook({ ...event, stop_hook_active: true }, directory);
  assert.equal(repeated.decision, undefined);
  assert.ok((await readState(directory, session)).taskHalt);
});
