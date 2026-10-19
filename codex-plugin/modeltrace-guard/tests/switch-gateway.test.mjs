import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import * as zlib from 'node:zlib';
import { startSwitchGateway } from '../scripts/switch-gateway.mjs';

const A = '019a0158-0ea5-7323-a123-123456789abc';
const B = '019a0158-0ea5-7323-a123-abcdef012345';
const TOKEN = 'synthetic-capability-123456789';
const AUTH = 'Bearer synthetic-official-oauth';
const DONE = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","model":"upstream-original-model"}}\n\n';
const defaultBody = { model: 'gpt-example', stream: true, input: [{ role: 'user', content: 'synthetic input' }] };

async function until(predicate, message = 'condition was not reached') {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) assert.fail(message); await delay(5); }
}

async function fixture(t, handle = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(DONE); }, options = {}) {
  const received = [], receipts = [];
  let readyCalls = 0;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const seen = { path: req.url, method: req.method, headers: req.headers, bytes, body: bytes.length ? JSON.parse(bytes) : null };
    received.push(seen);
    handle(req, res, seen, received.length);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const gateway = await startSwitchGateway({ upstream: upstreamUrl, token: TOKEN,
    resolveRoute: async () => ({ route: 'source', sourceKey: 'API2', revision: 0 }),
    verifyReady: async () => { readyCalls++; }, onReceipt: async (receipt) => { receipts.push(receipt); }, ...options });
  t.after(async () => {
    await gateway.close();
    await new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); });
  });
  return { gateway, received, receipts, upstreamUrl, readyCalls: () => readyCalls };
}

function send(gateway, { path = '/responses', rawPath, method = 'POST', thread = A, body = defaultBody, bytes, headers = {}, tolerateAbort = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(gateway.url + path);
    const payload = bytes ?? (body === null ? undefined : Buffer.from(JSON.stringify(body)));
    const requestHeaders = { authorization: AUTH, ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      ...(thread ? { 'thread-id': thread } : {}), ...headers };
    const req = httpRequest(target, { method, headers: requestHeaders, ...(rawPath ? { path: rawPath } : {}) }, (res) => {
      const chunks = []; let settled = false;
      const finish = (aborted) => { if (settled) return; settled = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), aborted }); };
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => finish(false));
      res.once('error', (error) => { if (tolerateAbort) finish(true); else reject(error); });
    });
    req.once('error', reject); req.end(payload);
  });
}

test('source forwarding changes only model, carries native authorization, and preserves SSE bytes', async (t) => {
  const sse = ': ping\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"中文 ✓ synthetic"}\r\n\r\n' + DONE;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'x-private-hop, keep-alive', 'x-private-hop': 'omit', 'x-retained': 'yes' });
    for (const byte of Buffer.from(sse)) res.write(Buffer.from([byte]));
    res.end();
  });
  const body = { ...defaultBody, reasoning: { effort: 'high', summary: 'auto' }, tools: [{ type: 'function', name: 'synthetic_tool', parameters: { type: 'object' } }],
    parallel_tool_calls: true, include: ['reasoning.encrypted_content'], input: [
      { type: 'reasoning', encrypted_content: 'synthetic-encrypted-blob', summary: [] },
      { role: 'user', content: [{ type: 'input_text', text: 'synthetic private message' }, { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj' }] },
      { type: 'function_call_output', call_id: 'call-test', output: '{"synthetic":true}' },
    ] };
  const response = await send(f.gateway, { body, headers: { connection: 'x-private-hop, keep-alive', 'x-private-hop': 'omit' } });
  assert.equal(response.status, 200); assert.equal(response.body, sse);
  assert.equal(response.headers['x-private-hop'], undefined); assert.equal(response.headers['x-retained'], 'yes');
  assert.equal(f.received.length, 1); assert.equal(f.received[0].path, '/v1/responses');
  assert.deepEqual(f.received[0].body, { ...body, model: 'ccs-API2/gpt-example' });
  assert.equal(f.received[0].headers.authorization, AUTH);
  assert.equal(f.received[0].headers['x-private-hop'], undefined);
  assert.equal(f.received[0].headers['accept-encoding'], 'identity');
  assert.equal(Number(f.received[0].headers['content-length']), f.received[0].bytes.length);
  assert.equal(f.readyCalls(), 1);
  await until(() => f.receipts.length === 1);
  const receipt = f.receipts[0];
  assert.deepEqual(Object.keys(receipt).sort(), ['requestId', 'threadId', 'route', 'revision', 'startedAt', 'statusCode', 'completed', 'success', 'responseEvent', 'finishedAt'].sort());
  assert.equal(receipt.route, 'source'); assert.equal(receipt.revision, 0); assert.equal(receipt.threadId, A);
  assert.equal(receipt.statusCode, 200); assert.equal(receipt.completed, true); assert.equal(receipt.success, true); assert.equal(receipt.responseEvent, 'response.completed');
  assert.match(receipt.requestId, /^[0-9a-f-]{36}$/); assert.equal(typeof receipt.startedAt, 'number'); assert.ok(receipt.finishedAt >= receipt.startedAt);
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic|encrypted|Bearer|capability|API2/);
});

test('switching one session preserves the other session and fallback body bytes', async (t) => {
  const routes = new Map([[A, { route: 'source', sourceKey: 'API2', revision: 0 }], [B, { route: 'source', sourceKey: 'SECOND', revision: 4 }]]);
  const f = await fixture(t, undefined, { resolveRoute: async (thread) => routes.get(thread) });
  await send(f.gateway); await send(f.gateway, { thread: B });
  routes.set(A, { route: 'fallback', revision: 1 });
  const bytes = Buffer.from('{ "model" : "gpt-example", "input": "preserve whitespace", "metadata":{"value":9007199254740993} }');
  await send(f.gateway, { bytes }); await send(f.gateway, { thread: B });
  assert.deepEqual(f.received.map(({ body }) => body.model), ['ccs-API2/gpt-example', 'ccs-SECOND/gpt-example', 'gpt-example', 'ccs-SECOND/gpt-example']);
  assert.deepEqual(f.received[2].bytes, bytes);
  await until(() => f.receipts.length === 4);
  assert.deepEqual(f.receipts.map(({ threadId, route, revision }) => [threadId, route, revision]), [[A, 'source', 0], [B, 'source', 4], [A, 'fallback', 1], [B, 'source', 4]]);
  assert.equal(new Set(f.receipts.map(({ requestId }) => requestId)).size, 4);
});

test('continuations retain all content within a revision and fail closed after a switch', async (t) => {
  let route = { route: 'source', sourceKey: 'API2', revision: 0 };
  const f = await fixture(t, undefined, { resolveRoute: async () => route });
  const continuation = { ...defaultBody, previous_response_id: 'resp-synthetic', input: [{ type: 'function_call_output', call_id: 'call-test', output: 'synthetic' }] };
  assert.equal((await send(f.gateway, { body: continuation })).status, 409);
  assert.equal(f.received.length, 0);
  await send(f.gateway);
  assert.equal((await send(f.gateway, { body: continuation })).status, 200);
  assert.deepEqual(f.received[1].body, { ...continuation, model: 'ccs-API2/gpt-example' });
  route = { route: 'fallback', revision: 1 };
  assert.equal((await send(f.gateway, { body: continuation })).status, 409);
  assert.equal(f.received.length, 2);
  await send(f.gateway);
  assert.equal((await send(f.gateway, { body: continuation })).status, 200);
  assert.deepEqual(f.received[3].body, continuation);
  route = { route: 'fallback', revision: 2 };
  assert.equal((await send(f.gateway, { body: continuation })).status, 409);
  assert.equal(f.received.length, 4);
  assert.equal(f.readyCalls(), 7);
});

test('evicted continuation metadata requires complete input without mutating previous_response_id', async (t) => {
  const f = await fixture(t, undefined, { maxTrackedThreads: 1 });
  await send(f.gateway); await send(f.gateway, { thread: B });
  assert.equal((await send(f.gateway, { body: { ...defaultBody, previous_response_id: 'resp-old' } })).status, 409);
  assert.equal(f.received.length, 2);
});

test('HTTP 200 failures, missing terminals and unterminated SSE frames never become successful receipts', async (t) => {
  const cases = [
    { data: 'data: {"type":"response.failed"}\n\n', event: 'response.failed' },
    { data: 'event: error\ndata: {"error":{"message":"synthetic failure"}}\n\n', event: 'error' },
    { data: 'data: {"type":"response.incomplete"}\n\n', event: 'response.incomplete' },
    { data: DONE + 'data: {"type":"response.failed"}\n\n', event: 'response.failed' },
    { data: 'data: {"type":"response.failed"}\n\n' + DONE, event: 'response.failed' },
    { data: 'data: [DONE]\n\n', event: null },
    { data: 'data: {"type":"response.completed"}', event: null },
    { data: 'data: {"type":"response.output_text.delta","delta":"response.completed"}\n\n', event: null },
    { data: 'event: response.completed\ndata: {"type":"response.failed"}\n\n', event: 'response.completed' },
    { data: 'data: {"type":"response.completed","response":{"status":"failed"}}\n\n', event: 'response.completed' },
  ];
  const f = await fixture(t, (_req, res, _seen, index) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(cases[index - 1].data); });
  for (const [index, expected] of cases.entries()) {
    assert.equal((await send(f.gateway)).body, expected.data);
    await until(() => f.receipts.length === index + 1);
    assert.equal(f.receipts[index].completed, true); assert.equal(f.receipts[index].success, false);
    assert.equal(f.receipts[index].responseEvent, expected.event);
  }
});

test('large SSE events remain byte-exact and completion can be observed with a bounded metadata buffer', async (t) => {
  const output = 'synthetic'.repeat(30_000);
  const frames = [
    `event: response.completed\ndata: ${JSON.stringify({ response: { output, status: 'completed' }, type: 'response.completed' })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.completed', response: { output, status: 'completed' } })}\n\n`,
  ];
  const f = await fixture(t, (_req, res, _seen, index) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frames[index - 1]); });
  for (let i = 0; i < frames.length; i++) {
    assert.equal((await send(f.gateway)).body, frames[i]);
    await until(() => f.receipts.length === i + 1);
    assert.equal(f.receipts[i].success, true);
    assert.ok(JSON.stringify(f.receipts[i]).length < 512);
  }
});

test('JSON response terminal statuses work while compaction cannot masquerade as a generation canary', async (t) => {
  const bodies = [{ object: 'response', status: 'completed' }, { object: 'response', status: 'failed' }, { error: { message: 'synthetic' } },
    { object: 'response.compaction', output: [{ type: 'compaction', encrypted_content: 'synthetic' }] }];
  const f = await fixture(t, (_req, res, _seen, index) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(bodies[index - 1])); });
  for (let i = 0; i < bodies.length; i++) {
    const result = await send(f.gateway, { path: i === 3 ? '/responses/compact' : '/responses', body: { ...defaultBody, stream: false } });
    assert.deepEqual(JSON.parse(result.body), bodies[i]);
    await until(() => f.receipts.length === i + 1);
    assert.equal(f.receipts[i].success, i === 0);
  }
  assert.equal(f.received[3].path, '/v1/responses/compact');
});

test('bounded gzip, deflate and available zstd decoding retain request content and remove encoding headers', async (t) => {
  const f = await fixture(t);
  const body = { ...defaultBody, input: [{ type: 'reasoning', encrypted_content: 'synthetic-encrypted' }] };
  const encoders = [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync]];
  if (zlib.zstdCompressSync) encoders.push(['zstd', zlib.zstdCompressSync]);
  for (const [encoding, encode] of encoders) {
    assert.equal((await send(f.gateway, { bytes: encode(Buffer.from(JSON.stringify(body))), headers: { 'content-encoding': encoding } })).status, 200);
    const last = f.received.at(-1);
    assert.deepEqual(last.body, { ...body, model: 'ccs-API2/gpt-example' });
    assert.equal(last.headers['content-encoding'], undefined);
    assert.equal(Number(last.headers['content-length']), last.bytes.length);
  }
  assert.equal((await send(f.gateway, { headers: { 'content-encoding': 'br' } })).status, 415);
  assert.equal((await send(f.gateway, { headers: { 'content-encoding': 'gzip, deflate' } })).status, 415);
  assert.equal((await send(f.gateway, { headers: { 'content-encoding': 'gzip' } })).status, 400);
  assert.equal(f.received.length, encoders.length);
});

test('wire and expanded request limits reject oversized bodies before any upstream request', async (t) => {
  const f = await fixture(t, undefined, { maxBodyBytes: 512 });
  const bytes = Buffer.from(JSON.stringify({ model: 'gpt-example', input: 'x'.repeat(5000) }));
  assert.equal((await send(f.gateway, { bytes })).status, 413);
  for (const [encoding, encode] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ...(zlib.zstdCompressSync ? [['zstd', zlib.zstdCompressSync]] : [])]) {
    assert.equal((await send(f.gateway, { bytes: encode(bytes), headers: { 'content-encoding': encoding } })).status, 413);
  }
  assert.equal(f.received.length, 0); assert.equal(f.readyCalls(), 0);
});

test('invalid JSON, non-UTF8 content and missing thread-id fail closed', async (t) => {
  const f = await fixture(t);
  for (const options of [{ bytes: Buffer.from('{') }, { body: [] }, { body: { input: 'missing-model' } }, { bytes: Buffer.from([0x7b, 0xff, 0x7d]) },
    { thread: null }, { thread: 'not-a-uuid' }, { thread: null, headers: { 'session-id': A } }]) {
    assert.equal((await send(f.gateway, options)).status, 400);
  }
  assert.equal((await send(f.gateway, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await send(f.gateway, { headers: { 'content-type': 'application/json; charset=latin1' } })).status, 415);
  assert.equal(f.received.length, 0);
  assert.equal((await send(f.gateway, { thread: A.toUpperCase(), headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 200);
  assert.equal((await send(f.gateway, { headers: { 'content-type': 'application/json; charset="utf-8"' } })).status, 200);
  await until(() => f.receipts.length === 2); assert.equal(f.receipts[0].threadId, A);
});

test('capability, Origin, Host, path and method guards apply before routing; exact GET models may omit thread-id', async (t) => {
  const f = await fixture(t, (_req, res, seen) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [], path: seen.path })); });
  for (const origin of ['https://external.invalid', 'null', '']) assert.equal((await send(f.gateway, { headers: { origin } })).status, 403);
  assert.equal((await send(f.gateway, { headers: { host: 'external.invalid' } })).status, 403);
  assert.equal((await send(f.gateway, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await send({ url: f.gateway.url.replace(TOKEN, 'wrong-capability-12345') })).status, 404);
  for (const path of ['/images/generations', '/alpha/search', '/responses/extra', '/models/extra?client_version=test', '/responses?url=http://external.invalid', '/responses/compact?x=1', '/health?x=1', '/shutdown?x=1']) {
    assert.equal((await send(f.gateway, { path })).status, 404);
  }
  assert.equal((await send(f.gateway, { method: 'GET', body: null })).status, 405);
  assert.equal((await send(f.gateway, { path: '/models' })).status, 405);
  assert.equal(f.received.length, 0); assert.equal(f.readyCalls(), 0);
  const result = await send(f.gateway, { path: '/models', method: 'GET', thread: null, body: null });
  assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), { data: [], path: '/v1/models' });
  assert.equal(f.received[0].headers.authorization, AUTH); assert.equal(f.readyCalls(), 1); assert.equal(f.receipts.length, 0);
});

test('models query bytes reach only the configured loopback path and fragments or alternative request targets are rejected', async (t) => {
  let externalRequests = 0;
  const other = createServer((_req, res) => { externalRequests++; res.end('must not be visited'); });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));
  const external = `http://127.0.0.1:${other.address().port}/other-path`;
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); });
  const queries = ['?client_version=0.163.0', `?url=${external}&path=/responses/compact`, '?encoded=%2f%23%2523&plus=a+b&repeat=1&repeat=2', '?', '?quote="literal"'];
  for (const query of queries) {
    const result = await send(f.gateway, { rawPath: `/${TOKEN}/v1/models${query}`, method: 'GET', thread: null, body: null });
    assert.equal(result.status, 200);
    assert.equal(f.received.at(-1).path, `/v1/models${query}`);
    assert.equal(f.received.at(-1).headers.authorization, AUTH);
    assert.equal(f.received.at(-1).headers.host, new URL(f.upstreamUrl).host);
  }
  for (const rawPath of [`/${TOKEN}/v1/models#fragment`, `/${TOKEN}/v1/models?client_version=0.163.0#fragment`,
    `/${TOKEN}/v1/models/../responses?client_version=0.163.0`, `//external.invalid/${TOKEN}/v1/models`, external]) {
    assert.equal((await send(f.gateway, { rawPath, method: 'GET', thread: null, body: null })).status, 404);
  }
  assert.equal((await send(f.gateway, { path: '/models?client_version=0.163.0' })).status, 405);
  assert.equal(f.received.length, queries.length); assert.equal(externalRequests, 0);
  assert.equal(f.readyCalls(), queries.length); assert.equal(f.receipts.length, 0);
});

test('model discovery does not forward authentication after CCSwitch configuration drift', async t => {
  const f = await fixture(t, undefined, { verifyReady: async () => { throw new Error('configuration drift'); } });
  const result = await send(f.gateway, { path: '/models?client_version=test', method: 'GET', thread: null, body: null });
  assert.equal(result.status, 503);
  assert.equal(f.received.length, 0);
});

test('WebSocket upgrades receive explicit HTTP 426 without bypassing Origin or capability guards', async (t) => {
  const f = await fixture(t);
  assert.equal((await send(f.gateway, { method: 'GET', body: null, headers: { connection: 'Upgrade', upgrade: 'websocket' } })).status, 426);
  assert.equal((await send(f.gateway, { method: 'GET', body: null, headers: { connection: 'Upgrade', upgrade: 'websocket', origin: 'null' } })).status, 403);
  assert.equal(f.received.length, 0); assert.equal(f.readyCalls(), 0);
});

test('upstream configuration cannot send Authorization to DNS hosts, remote addresses or other endpoints', async () => {
  const options = { token: TOKEN, resolveRoute: async () => ({ route: 'fallback', revision: 0 }), verifyReady: async () => {} };
  for (const upstream of ['http://remote.invalid/v1', 'http://localhost:15721/v1', 'http://192.168.0.1/v1', 'https://127.0.0.1/v1',
    'http://user:secret@127.0.0.1/v1', 'http://127.0.0.1/v1?url=remote', 'http://127.0.0.1/v1#remote', 'http://127.0.0.1/other']) {
    await assert.rejects(startSwitchGateway({ ...options, upstream }), /numeric loopback/);
  }
});

test('HTTP errors and redirects are forwarded once without following a credential-bearing redirect', async (t) => {
  let redirected = 0;
  const other = createServer((_req, res) => { redirected++; res.end('must not be visited'); });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));
  const location = `http://127.0.0.1:${other.address().port}/remote`;
  const f = await fixture(t, (_req, res, _seen, index) => {
    res.writeHead(index === 1 ? 429 : 302, { 'content-type': 'application/json', 'retry-after': '7', location });
    res.end('{"error":{"message":"synthetic upstream error"}}');
  });
  for (const status of [429, 302]) {
    const result = await send(f.gateway);
    assert.equal(result.status, status); assert.equal(result.headers['retry-after'], '7'); assert.equal(result.headers.location, location);
    assert.equal(result.body, '{"error":{"message":"synthetic upstream error"}}');
  }
  await until(() => f.receipts.length === 2);
  assert.equal(f.received.length, 2); assert.equal(redirected, 0);
  assert.ok(f.receipts.every((r) => r.completed && !r.success));
});

test('an interrupted upstream stream is never successful, even after a completed event, and is never replayed', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(DONE);
    setTimeout(() => res.destroy(), 20);
  });
  const response = await send(f.gateway, { tolerateAbort: true });
  assert.equal(response.status, 200); assert.equal(response.body, DONE); assert.equal(response.aborted, true);
  await until(() => f.receipts.length === 1);
  assert.equal(f.receipts[0].completed, false); assert.equal(f.receipts[0].success, false);
  assert.equal(f.received.length, 1);
});

test('client disconnect cancels the upstream SSE and emits a single incomplete receipt', async (t) => {
  let cancelled = false;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"response.output_text.delta","delta":"synthetic"}\n\n');
    res.once('close', () => { cancelled = true; });
  });
  await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.gateway.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'thread-id': A, authorization: AUTH } }, (res) => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.once('error', reject); req.end(JSON.stringify(defaultBody));
  });
  await until(() => cancelled && f.receipts.length === 1);
  assert.equal(f.receipts[0].completed, false); assert.equal(f.receipts[0].success, false); assert.equal(f.received.length, 1);
});

test('idle upstream timeout fails without replay and readiness fails before Authorization is forwarded', async (t) => {
  const f = await fixture(t, () => {}, { upstreamTimeoutMs: 40 });
  assert.equal((await send(f.gateway)).status, 504);
  await until(() => f.receipts.length === 1);
  assert.equal(f.receipts[0].completed, false); assert.equal(f.receipts[0].success, false); assert.equal(f.received.length, 1);
  let checks = 0;
  const blocked = await fixture(t, undefined, { verifyReady: async () => { checks++; throw new Error('synthetic sensitive details'); } });
  const result = await send(blocked.gateway);
  assert.equal(result.status, 503); assert.doesNotMatch(result.body, /sensitive details/);
  assert.equal(checks, 1); assert.equal(blocked.received.length, 0);
  await until(() => blocked.receipts.length === 1); assert.equal(blocked.receipts[0].success, false);
});

test('failed generation does not establish continuation safety and receipt callback failure cannot replay it', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"type":"response.failed"}\n\n'); },
    { onReceipt: async () => { calls++; throw new Error('synthetic observer failure'); } });
  assert.equal((await send(f.gateway)).status, 200);
  assert.equal((await send(f.gateway, { body: { ...defaultBody, previous_response_id: 'resp-failed' } })).status, 409);
  await until(() => calls === 2);
  assert.equal(f.received.length, 1);
});

test('health and shutdown control only the capability-owned instance and never probe CCSwitch', async (t) => {
  let stopped = 0;
  const instanceId = '019a0158-0ea5-7323-a123-000000000000';
  const f = await fixture(t, undefined, { instanceId, onShutdown: async () => { stopped++; } });
  assert.equal((await send(f.gateway, { path: '/health', body: null, thread: null })).status, 405);
  assert.equal((await send(f.gateway, { path: '/shutdown', method: 'GET', body: null, thread: null })).status, 405);
  assert.equal((await send(f.gateway, { path: '/shutdown', body: null, thread: null, headers: { origin: 'null' } })).status, 403);
  assert.equal((await send(f.gateway, { path: '/shutdown', body: null, thread: null, headers: { host: 'external.invalid' } })).status, 403);
  const health = await send(f.gateway, { path: '/health', method: 'GET', body: null, thread: null });
  assert.deepEqual(JSON.parse(health.body), { ok: true, instanceId });
  assert.equal(health.status, 200); assert.equal(stopped, 0);
  const shutdown = await send(f.gateway, { path: '/shutdown', body: null, thread: null });
  assert.deepEqual(JSON.parse(shutdown.body), { ok: true, instanceId });
  assert.equal(shutdown.status, 200);
  await until(() => stopped === 1);
  await assert.rejects(send(f.gateway, { path: '/health', method: 'GET', body: null, thread: null }), (error) => ['ECONNREFUSED', 'ECONNRESET'].includes(error.code));
  assert.equal(f.readyCalls(), 0); assert.equal(f.received.length, 0); assert.equal(f.receipts.length, 0);
  await f.gateway.close(); assert.equal(stopped, 1);
});

test('a request pins its resolved route across asynchronous readiness checks', async (t) => {
  let ready;
  const gate = new Promise((resolve) => { ready = resolve; });
  const route = { route: 'source', sourceKey: 'API2', revision: 5 };
  let checking = false;
  const f = await fixture(t, undefined, { resolveRoute: async () => route, verifyReady: async () => { checking = true; await gate; } });
  const pending = send(f.gateway);
  await until(() => checking);
  route.route = 'fallback'; route.revision = 6;
  ready();
  assert.equal((await pending).status, 200);
  assert.equal(f.received[0].body.model, 'ccs-API2/gpt-example');
  await until(() => f.receipts.length === 1);
  assert.equal(f.receipts[0].route, 'source'); assert.equal(f.receipts[0].revision, 5);
});

test('gateway close cancels active inference and drains its terminal receipt', async (t) => {
  let connected = false, recorded = false;
  const f = await fixture(t, (_req, res) => {
    connected = true; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n');
  }, { onReceipt: async (receipt) => { await delay(10); assert.equal(receipt.success, false); recorded = true; } });
  const pending = send(f.gateway, { tolerateAbort: true });
  await until(() => connected);
  await f.gateway.close();
  assert.equal(recorded, true); assert.equal((await pending).aborted, true); assert.equal(f.received.length, 1);
});

test('incoming body timeout rejects a stalled upload without contacting upstream', async (t) => {
  const f = await fixture(t, undefined, { bodyTimeoutMs: 40 });
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.gateway.url}/responses`, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': '100', 'thread-id': A, authorization: AUTH,
    } }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.write('{');
  });
  assert.equal(result, 408); assert.equal(f.received.length, 0);
});
