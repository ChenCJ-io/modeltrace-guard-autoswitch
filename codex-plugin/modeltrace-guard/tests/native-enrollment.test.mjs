import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ENROLLMENT_INSTRUCTIONS, referenceThreadParameters, referenceInput, verifiedReferenceReceipt,
  referenceRow, referenceRelay, collectNativeReference, referenceQuality, standardCreditEquivalent } from '../scripts/native-enrollment.mjs';

const challenge = { condition: 'environment-07', challenge_id: 'query-19', expected_count: 100,
  transport: 'system', system: 'Synthetic system-prefix variation.', user_prefix: '', prompt: 'Synthetic numeric task.' };
const config = { id: randomUUID() }, target = { id: 'official', fingerprint: 'a'.repeat(64) };
const threadId = randomUUID(), startedAt = 1000;
const receipt = { configId: config.id, threadId, providerId: target.id, providerFingerprint: target.fingerprint,
  transport: 'official', sourceKey: null, statusCode: 200, completed: true, success: true,
  responseEvent: 'response.completed', startedAt: startedAt + 1, finishedAt: startedAt + 2, requestId: randomUUID() };

test('native enrollment preserves system and user prefix variations in their actual roles', () => {
  const params = referenceThreadParameters({ model: 'synthetic-model', effort: 'max', cwd: '/synthetic/empty', challenge });
  assert.equal(params.ephemeral, true); assert.equal(params.modelProvider, 'openai');
  assert.equal(params.allowProviderModelFallback, false); assert.equal(params.sandbox, 'read-only');
  assert.deepEqual(params.dynamicTools, []); assert.deepEqual(params.environments, []);
  assert.equal(params.config.model_reasoning_effort, 'max');
  assert.equal(params.developerInstructions, `${ENROLLMENT_INSTRUCTIONS}\n\n${challenge.system}`);
  assert.equal(referenceInput(challenge), challenge.prompt);
  const userChallenge = { ...challenge, system: '', transport: 'user', user_prefix: 'Synthetic user prefix.' };
  assert.equal(referenceInput(userChallenge), `${userChallenge.user_prefix}\n\n${challenge.prompt}`);
  assert.equal(referenceThreadParameters({ model: 'synthetic-model', effort: 'max', cwd: '/synthetic/empty', challenge: userChallenge }).developerInstructions,
    ENROLLMENT_INSTRUCTIONS);
});

test('native enrollment refuses stale, changed, incomplete and nonofficial route receipts', () => {
  const conditions = { config, target, threadId, startedAt };
  assert.equal(verifiedReferenceReceipt(receipt, conditions), true);
  for (const changes of [
    { configId: randomUUID() }, { threadId: randomUUID() }, { providerId: 'other' }, { providerFingerprint: 'b'.repeat(64) },
    { transport: 'ccswitch' }, { sourceKey: 'other' }, { statusCode: 500 }, { completed: false }, { success: false },
    { responseEvent: 'response.failed' }, { startedAt: 999 }, { finishedAt: 1000 },
  ]) assert.equal(verifiedReferenceReceipt({ ...receipt, ...changes }, conditions), false, JSON.stringify(changes));
  assert.equal(verifiedReferenceReceipt(null, conditions), false);
});

test('heldout data retains validated provenance without receiving training approval', () => {
  const generated = { text: Array.from({ length: 100 }, (_, index) => ((index * index + 31 * index + 17) % 355) + 1).join(','), usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 100 } };
  const options = { model: 'synthetic-model', effort: 'max', challenge, generated, receipt, config, target,
    threadId, startedAt, cliVersion: 'synthetic-cli', collectionId: 'synthetic-collection', now: 'synthetic-time' };
  const train = referenceRow(options);
  assert.equal(train.strict_valid, true); assert.equal(train.training_approved, true); assert.equal(train.route_verified, true);
  assert.equal(train.parsed_count, 100); assert.equal(train.prompt, challenge.prompt); assert.equal(train.base_prompt, challenge.prompt);
  assert.equal(train.wrapper_transport, 'system'); assert.equal(train.system_prompt, challenge.system);
  assert.equal(train.wrapper_system_role, 'developer'); assert.equal(train.route_evidence.providerFingerprint, target.fingerprint);
  assert.deepEqual(train.usage, generated.usage);
  const heldout = referenceRow({ ...options, split: 'heldout' });
  assert.equal(heldout.strict_valid, true); assert.equal(heldout.training_approved, false); assert.equal(heldout.split, 'heldout');
  const unverified = referenceRow({ ...options, receipt: { ...receipt, completed: false } });
  assert.equal(unverified.strict_valid, false); assert.equal(unverified.training_approved, false);
  const short = referenceRow({ ...options, generated: { ...generated, text: '123,124' } });
  assert.equal(short.strict_valid, false); assert.equal(short.training_approved, false);
  assert.equal(train.provider, 'codex'); assert.equal(train.pattern_valid, true);
});

test('reference quality excludes gross count deviations and rule-generated sequences', () => {
  assert.equal(referenceQuality(Array(100).fill(123).join(','), 100).valid, false);
  assert.equal(referenceQuality(Array.from({ length: 100 }, (_, index) => index + 1).join(','), 100).valid, false);
  assert.equal(referenceQuality(Array.from({ length: 100 }, (_, index) => [11, 31, 17][index % 3]).join(','), 100).valid, false);
  assert.equal(referenceQuality(Array.from({ length: 140 }, (_, index) => ((index * index + 31 * index + 17) % 355) + 1).join(','), 100).valid, false);
});

test('credit estimate uses cached input separately and refuses missing usage', () => {
  assert.equal(standardCreditEquivalent({ inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 }), 0.0655);
  assert.equal(standardCreditEquivalent(null), null);
  assert.equal(standardCreditEquivalent({ inputTokens: 100, cachedInputTokens: 101, outputTokens: 10 }), null);
});

test('invalid collection parameters and challenges are rejected before connecting or starting inference', async () => {
  let called = false;
  const runtime = { loadGatewayConfig: async () => { called = true; throw new Error('Unexpected connection'); } };
  const options = { directory: '/synthetic/data', output: '/synthetic/output', model: 'synthetic-model', suite: [challenge] };
  for (const changes of [{ suite: [] }, { model: '' }, { output: 'relative' }, { split: 'unknown' },
    { suite: [{ ...challenge, transport: 'clean' }] }, { suite: [challenge, challenge] }]) {
    await assert.rejects(collectNativeReference({ ...options, ...changes }, runtime));
    assert.equal(called, false);
  }
});

test('reference relay retains native headers and drains through EOF after downstream closes', async t => {
  let received, ended = false;
  const upstream = createServer((req, res) => {
    received = { path: req.url, authorization: req.headers.authorization, threadId: req.headers['thread-id'], encoding: req.headers['accept-encoding'] };
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: synthetic-first\n\n');
    setTimeout(() => { res.end('data: synthetic-last\n\n'); ended = true; }, 20);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const providerPath = `/${'a'.repeat(64)}/provider/synthetic-official/v1`;
  const relay = await referenceRelay(new URL(`http://127.0.0.1:${upstream.address().port}${providerPath}`));
  t.after(() => relay.close());
  await new Promise((resolve, reject) => {
    const req = request(`${relay.url}/responses`, { method: 'POST', headers: { authorization: 'synthetic-native-token', 'thread-id': threadId } }, res => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.once('error', reject); req.end('{}');
  });
  for (let attempt = 0; attempt < 50 && !relay.observations[0]?.ended; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(received, { path: `${providerPath}/responses`, authorization: 'synthetic-native-token', threadId, encoding: 'identity' });
  assert.equal(ended, true); assert.equal(relay.observations[0].ended, true);
  assert.doesNotMatch(JSON.stringify(relay.observations), /synthetic-native-token|synthetic-capability/);
});

test('reference relay refuses remote targets before accepting any native authentication', async () => {
  for (const value of ['https://example.invalid/v1', 'http://localhost:15722/v1', 'http://127.0.0.1:15722/v1',
    `http://127.0.0.1:15722/${'a'.repeat(64)}/provider/official/v1?redirect=1`]) {
    await assert.rejects(referenceRelay(new URL(value)), /selected local gateway/);
  }
});

test('collection stops at its request budget and never starts the unreserved sample', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'modeltrace-budget-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'collection');
  let threads = 0, turns = 0, lastThreadId, lastRequestAt;
  const official = { id: 'synthetic-official', fingerprint: 'a'.repeat(64), transport: 'official', name: 'Synthetic Official' };
  const gateway = { id: randomUUID() };
  const model = 'synthetic-model';
  const values = Array.from({ length: 100 }, (_, index) => ((index * index + 31 * index + 17) % 355) + 1);
  class FakeClient {
    listeners = new Set(); exited = new Promise(() => {}); closed = false;
    write() {}
    async close() { this.closed = true; }
    async request(method) {
      if (method === 'thread/start') {
        threads++; lastThreadId = randomUUID(); lastRequestAt = Date.now();
        return { thread: { id: lastThreadId, ephemeral: true, path: null }, model, modelProvider: 'openai', reasoningEffort: 'max' };
      }
      return {};
    }
  }
  const summary = await collectNativeReference({ directory: root, output, model, effort: 'max',
    maxCredits: 2.51, suite: [challenge, { ...challenge, challenge_id: 'query-20' }] }, {
    loadGatewayConfig: async () => gateway,
    verifyGatewayReady: async () => ({}), resolveProvider: () => official, assertProviderCurrent() {},
    gatewayURL: () => `http://127.0.0.1:15722/${'a'.repeat(64)}/provider/synthetic-official/v1`,
    codexExecutable: async () => process.execPath,
    disabledHooksOverride: () => [], AppServerClient: FakeClient,
    openAppServer: async () => ({ request: async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : {}, close: async () => {} }),
    requireTrustedGuard: async () => ({ otherHookKeys: [] }),
    generateProbe: async () => {
      turns++;
      return { text: values.join(','), usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 } };
    },
    readReceipt: async () => ({ ...receipt, configId: gateway.id, providerId: official.id,
      providerFingerprint: official.fingerprint, threadId: lastThreadId, startedAt: lastRequestAt, finishedAt: Date.now() }),
  });
  assert.equal(threads, 1); assert.equal(turns, 1);
  assert.equal(summary.status, 'failed'); assert.match(summary.error, /budget reservation/);
  assert.equal(summary.standardCreditEquivalent, 0.075);
  assert.equal(summary.acceptedSamples, 1);
  assert.equal(JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8')).usage.outputTokens, 100);
});
