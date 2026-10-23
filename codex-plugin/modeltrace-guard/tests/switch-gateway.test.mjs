import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import * as zlib from 'node:zlib';
import { GATEWAY_IMPLEMENTATION_VERSION, startSwitchGateway } from '../scripts/switch-gateway.mjs';

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

async function officialFixture(t, handle, options = {}) {
  let f;
  const officialCalls = [];
  f = await fixture(t, handle, {
    resolveRoute: async () => ({ route: 'fallback', transport: 'official', providerId: 'official-test', revision: 3 }),
    // Test-only injection: inspect the genuine fixed HTTPS target, but perform
    // the I/O against the synthetic local server; no account/network is involved.
    officialRequestImpl: (target, settings, callback) => {
      officialCalls.push({ url: target.href, headers: settings.headers, rejectUnauthorized: settings.rejectUnauthorized });
      return httpRequest(f.upstreamUrl, { method: settings.method, headers: settings.headers, path: target.pathname, agent: false }, callback);
    }, ...options,
  });
  return { ...f, officialCalls };
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
  assert.deepEqual(Object.keys(receipt).sort(), ['requestId', 'threadId', 'route', 'revision', 'providerId', 'transport', 'sourceKey', 'ccswitchMode', 'providerFingerprint', 'proposalId', 'approvalId', 'challenge', 'startedAt', 'statusCode', 'completed', 'success', 'responseEvent', 'finishedAt'].sort());
  assert.equal(receipt.route, 'source'); assert.equal(receipt.revision, 0); assert.equal(receipt.threadId, A);
  assert.equal(receipt.statusCode, 200); assert.equal(receipt.completed, true); assert.equal(receipt.success, true); assert.equal(receipt.responseEvent, 'response.completed');
  assert.match(receipt.requestId, /^[0-9a-f-]{36}$/); assert.equal(typeof receipt.startedAt, 'number'); assert.ok(receipt.finishedAt >= receipt.startedAt);
  assert.equal(receipt.providerId, null); assert.equal(receipt.transport, 'ccswitch'); assert.equal(receipt.sourceKey, 'API2');
  assert.equal(receipt.providerFingerprint, null); assert.equal(receipt.proposalId, null); assert.equal(receipt.approvalId, null); assert.equal(receipt.challenge, null);
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic|encrypted|Bearer|capability/);
});

test('native default forwarding avoids Stack client-header stripping and preserves decoded request bytes', async t => {
  let route = { route: 'source', transport: 'ccswitch', ccswitchMode: 'stack', providerId: 'company', sourceKey: 'API2', revision: 0 };
  const nativeHeaders = { originator: 'codex_cli_rs', version: 'test-version', 'user-agent': 'codex_cli_rs/test-version',
    'x-codex-beta-features': 'synthetic-native-protocol', session_id: A, 'x-client-request-id': 'synthetic-request' };
  const f = await fixture(t, (_req, res, seen) => {
    // CCSwitch's Stack path removes native client identification before reaching
    // a provider; plain default routing preserves it. No forged headers needed.
    const forwardedHeaders = { ...seen.headers };
    if (seen.body.model.startsWith('ccs-')) {
      for (const name of ['originator', 'version', 'session_id', 'thread-id', 'x-client-request-id']) delete forwardedHeaders[name];
    }
    if (!forwardedHeaders.originator || !forwardedHeaders.version) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'This account only allows Codex official clients' } }));
    } else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(DONE); }
  }, { resolveRoute: () => route });
  const failed = await send(f.gateway, { headers: nativeHeaders });
  assert.equal(failed.status, 403); assert.match(failed.body, /only allows Codex official clients/);
  route = { ...route, ccswitchMode: 'default' };
  const bytes = Buffer.from('{ "model": "gpt-example", "stream": true, "metadata": {"large":9007199254740993}, "input": "native bytes" }');
  const encoders = [['identity', value => value], ['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync]];
  if (zlib.zstdCompressSync) encoders.push(['zstd', zlib.zstdCompressSync]);
  for (const [encoding, encode] of encoders) {
    const result = await send(f.gateway, { bytes: encode(bytes), headers: { ...nativeHeaders, 'content-encoding': encoding } });
    assert.equal(result.status, 200); assert.equal(result.body, DONE);
    const seen = f.received.at(-1);
    assert.deepEqual(seen.bytes, bytes); assert.equal(seen.body.model, 'gpt-example');
    for (const [name, value] of Object.entries(nativeHeaders)) assert.equal(seen.headers[name], value);
    assert.equal(seen.headers['thread-id'], A); assert.equal(seen.headers['content-encoding'], undefined);
  }
  await until(() => f.receipts.length === encoders.length + 1);
  assert.equal(f.receipts[0].success, false);
  assert.ok(f.receipts.slice(1).every(row => row.success && row.ccswitchMode === 'default'));
});

test('default route is rechecked immediately before forwarding and cannot be applied to a backup or Official', async t => {
  let drift = false, route = { route: 'source', transport: 'ccswitch', ccswitchMode: 'default', providerId: 'company', sourceKey: 'API2', revision: 1 };
  const checked = [];
  const f = await fixture(t, undefined, {
    resolveRoute: () => route,
    verifyReady: selected => { checked.push(selected); return !drift; },
  });
  assert.equal((await send(f.gateway)).status, 200);
  assert.equal(checked[0].ccswitchMode, 'default');
  drift = true;
  assert.equal((await send(f.gateway)).status, 503);
  assert.equal(f.received.length, 1, 'a drifting default is never forwarded or retried with Stack');
  drift = false;
  for (const invalid of [
    { ...route, route: 'fallback' }, { ...route, transport: 'official' }, { ...route, providerId: null },
    { ...route, ccswitchMode: 'unknown' },
  ]) {
    route = invalid;
    assert.equal((await send(f.gateway)).status, 503);
  }
  assert.equal(f.received.length, 1);
});

test('client Stack selectors cannot redirect primary or backup requests or falsify route receipts', async t => {
  const routes = [
    { route: 'source', transport: 'ccswitch', ccswitchMode: 'default', providerId: 'company', sourceKey: 'API2', revision: 0 },
    { route: 'fallback', transport: 'ccswitch', ccswitchMode: 'stack', providerId: 'backup', sourceKey: 'BACKUP', revision: 1 },
    { route: 'fallback', transport: 'official', providerId: 'official', revision: 1 },
  ];
  for (const route of routes) {
    const f = route.transport === 'official' ? await officialFixture(t) : await fixture(t, undefined, { resolveRoute: () => route });
    for (const model of ['ccs-other/gpt-example', 'ccs-API2/gpt-example', 'ccs-/gpt-example', 'ccs-other/nested/model']) {
      const result = await send(f.gateway, { body: { ...defaultBody, model } });
      assert.equal(result.status, 400); assert.match(result.body, /plain model ID is required/);
    }
    assert.equal(f.received.length, 0); assert.equal(f.receipts.length, 0);
    assert.equal((await send(f.gateway, { body: { ...defaultBody, model: 'ccs-plain-name-without-selector' } })).status, 200);
  }
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
    { data: 'event: response.output_text.delta\ndata: {"type":"response.completed"}\n\n', event: 'response.completed' },
    { data: 'data: {"type":"response.output_text.delta","status":"completed"}\n\n', event: null },
    { data: DONE + 'data: [DONE]' + ' '.repeat(64) + 'malformed\n\n', event: 'response.completed' },
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
    assert.ok(JSON.stringify(f.receipts[i]).length < 768);
  }
});

test('oversized terminal data must be complete valid JSON and all status/type metadata must agree', async (t) => {
  const output = 'synthetic'.repeat(30_000);
  const valid = JSON.stringify({ type: 'response.completed', response: { output, status: 'completed' } });
  const invalidData = [
    valid.slice(0, -1),
    valid + ' trailing',
    JSON.stringify({ type: 'response.completed', response: { output, status: 'failed' } }),
    JSON.stringify({ type: 'response.completed', response: { output, status: 'incomplete' } }),
    JSON.stringify({ response: { output, status: 'completed' }, type: 'response.failed' }),
    JSON.stringify({ response: { output, status: 'completed' }, type: 'response.output_text.delta' }),
    `{"type":"response.completed","response":{"output":"${output}" BROKEN,"status":"completed"}}`,
    `{"type":"response.completed","response":{"output":"${output}","status":"completed"},"type":"response.failed"}`,
    JSON.stringify({ type: 'response.completed', response: { output, status: 'completed' }, error: { message: 'synthetic' } }),
  ];
  const cases = invalidData.flatMap(data => [
    { body: `event: response.completed\ndata: ${data}\n\n`, headers: {} },
    { body: `event: response.completed\ndata: ${data}\n\n`, headers: { 'content-type': 'text/event-stream' } },
  ]);
  const f = await fixture(t, (_req, res, _seen, index) => {
    const { body, headers } = cases[index - 1];
    res.writeHead(200, headers); res.end(body);
  });
  for (const [index, expected] of cases.entries()) {
    assert.equal((await send(f.gateway)).body, expected.body);
    await until(() => f.receipts.length === index + 1);
    assert.equal(f.receipts[index].completed, true);
    assert.equal(f.receipts[index].success, false, `oversized case ${index}`);
  }
});

test('terminal JSON validates nested values, escapes and numeric grammar without retaining output strings', async (t) => {
  const valid = [
    '{"type":"response.completed","response":{"status":"completed","output":{"a":[],"b":{},"c":[true,false,null,0,-1,1.5,-3e+20]}},"error":null}',
    '{"type":"response.completed","response":{"status":"completed","output":"quote: \\" slash: \\\\ control: \\n unicode: \\u4e2d"}}',
    '{"\\u0074ype":"response.completed","response":{"\\u0073tatus":"completed"}}',
    JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: 'x'.repeat(270_000) } }),
  ];
  const malformed = [
    '{"type":"response.completed","output":[1,]}',
    '{"type":"response.completed",}',
    '{"type":"response.completed","output":{"x" 1}}',
    '{"type":"response.completed","output":01}',
    '{"type":"response.completed","output":1.}',
    '{"type":"response.completed","output":1e}',
    '{"type":"response.completed","output":tru}',
    '{"type":"response.completed","output":"\\q"}',
    '{"type":"response.completed","output":"\\u0xz0"}',
    '{"type":"response.completed","output":"raw\nnewline"}',
    '{"type":"response.completed","response":{"status":"completed","status":"failed"}}',
    '{"type":"response.completed","response":{"status":"completed"},"response":{"status":"failed"}}',
    '{"type":"response.completed","response":{"status":null}}',
    '{"type":"response.completed","type":null}',
  ];
  const cases = [...valid.map(body => ({ body, success: true })), ...malformed.map(body => ({ body, success: false }))]
    .flatMap(row => [{ ...row, format: 'sse' }, { ...row, format: 'json' }]);
  const f = await fixture(t, (_req, res, _seen, index) => {
    const { body, format } = cases[index - 1];
    res.writeHead(200, { 'content-type': format === 'sse' ? 'text/event-stream' : 'application/json' });
    const text = format === 'sse' ? `data: ${body}\n\n` : body;
    for (let offset = 0; offset < text.length; offset += 127) res.write(text.slice(offset, offset + 127));
    res.end();
  });
  for (const [index, expected] of cases.entries()) {
    const result = await send(f.gateway);
    assert.equal(result.body, expected.format === 'sse' ? `data: ${expected.body}\n\n` : expected.body);
    await until(() => f.receipts.length === index + 1);
    assert.equal(f.receipts[index].success, expected.success, `JSON grammar case ${index}`);
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

test('missing Content-Type accepts only complete SSE or JSON terminal evidence and preserves response bytes', async (t) => {
  const cases = [
    { body: ': upstream ping\r\n\r\n' + DONE, success: true, event: 'response.completed' },
    { body: '\ufeffevent: response.created\ndata: {"type":"response.created"}\n\n' + DONE, success: true, event: 'response.completed' },
    { body: ' \n{"object":"response","status":"completed"}', success: true, event: 'response.completed' },
    { body: `data: ${JSON.stringify({ type: 'response.completed', response: { output: 'synthetic'.repeat(30_000), status: 'completed' } })}\n\n`, success: true, event: 'response.completed' },
    { body: 'data: {"type":"response.failed"}\n\n', success: false, event: 'response.failed' },
    { body: DONE + 'data: {"type":"response.incomplete"}\n\n', success: false, event: 'response.incomplete' },
    { body: 'event: error\ndata: {"error":{"message":"synthetic"}}\n\n', success: false, event: 'error' },
    { body: '{"status":"failed"}', success: false, event: 'response.failed' },
    { body: '{"error":{"message":"synthetic"}}', success: false, event: 'error' },
    { body: 'data: [DONE]\n\n', success: false, event: null },
    { body: 'data: {"type":"response.completed"}', success: false, event: null },
    { body: 'data: {"type":"response.completed"}\n', success: false, event: null },
    { body: 'event: response.completed\ndata: {"type":"response.failed"}\n\n', success: false, event: 'response.completed' },
    { body: 'data: {"type":"response.completed","response":{"status":"failed"}}\n\n', success: false, event: 'response.completed' },
    { body: 'data: {"type":"response.completed" invalid}\n\n', success: false, event: null },
    { body: '{"status":"completed"', success: false, event: null },
    { body: '{"status":"completed"} trailing', success: false, event: null },
    { body: '<html>response.completed</html>', success: false, event: null },
    { body: 'x'.repeat(128_000) + DONE, success: false, event: null },
    { body: DONE, headers: { 'content-type': 'text/plain' }, success: false, event: null },
    { body: DONE, headers: { 'content-encoding': 'synthetic-unknown' }, success: false, event: null },
  ];
  const f = await fixture(t, (_req, res, _seen, index) => {
    const { body, headers } = cases[index - 1];
    res.writeHead(200, headers || {});
    if (index <= 3) {
      for (const byte of Buffer.from(body)) res.write(Buffer.from([byte]));
    } else res.write(body);
    res.end();
  });
  for (const [index, expected] of cases.entries()) {
    const result = await send(f.gateway);
    assert.equal(result.body, expected.body);
    assert.equal(result.headers['content-type'], expected.headers?.['content-type']);
    await until(() => f.receipts.length === index + 1);
    assert.equal(f.receipts[index].completed, true);
    assert.equal(f.receipts[index].success, expected.success, `case ${index}`);
    assert.equal(f.receipts[index].responseEvent, expected.event, `case ${index}`);
  }
});

test('missing Content-Type recognition survives separately delivered UTF-8 BOM and SSE prefix chunks', async (t) => {
  const chunks = [Buffer.from([0xef]), Buffer.from([0xbb]), Buffer.from([0xbf]), Buffer.from('ev'), Buffer.from('ent:'), Buffer.from(DONE.slice(6))];
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200); res.flushHeaders();
    void (async () => {
      for (const chunk of chunks) { res.write(chunk); await delay(1); }
      res.end();
    })();
  });
  assert.equal((await send(f.gateway)).body, '\ufeff' + DONE);
  await until(() => f.receipts.length === 1);
  assert.equal(f.receipts[0].success, true); assert.equal(f.receipts[0].responseEvent, 'response.completed');
});

test('missing Content-Type cannot make an interrupted response successful after a terminal event', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200); res.write(DONE);
    setTimeout(() => res.destroy(), 20);
  });
  const result = await send(f.gateway, { tolerateAbort: true });
  assert.equal(result.body, DONE); assert.equal(result.aborted, true);
  await until(() => f.receipts.length === 1);
  assert.equal(f.receipts[0].completed, false); assert.equal(f.receipts[0].success, false);
  assert.equal(f.received.length, 1);
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
  assert.deepEqual(JSON.parse(health.body), { ok: true, instanceId, implementationVersion: GATEWAY_IMPLEMENTATION_VERSION });
  assert.equal(health.status, 200); assert.equal(stopped, 0);
  const shutdown = await send(f.gateway, { path: '/shutdown', body: null, thread: null });
  assert.deepEqual(JSON.parse(shutdown.body), { ok: true, instanceId, implementationVersion: GATEWAY_IMPLEMENTATION_VERSION });
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

test('primary uses the native CCSwitch default while approved third-party backup uses an explicit Stack selector', async (t) => {
  let route = { route: 'source', transport: 'ccswitch', ccswitchMode: 'default', providerId: 'company-config', sourceKey: 'API2-copy', revision: 0 };
  const f = await fixture(t, undefined, { resolveRoute: async () => route });
  await send(f.gateway);
  route = { route: 'fallback', transport: 'ccswitch', providerId: 'approved-backup', sourceKey: 'BACKUP', revision: 1,
    providerFingerprint: 'f'.repeat(64), proposalId: 'proposal-test', approvalId: 'approval-test', challenge: 7 };
  await send(f.gateway);
  assert.deepEqual(f.received.map(({ body }) => body.model), ['gpt-example', 'ccs-BACKUP/gpt-example']);
  await until(() => f.receipts.length === 2);
  assert.deepEqual(f.receipts.map(({ providerId, transport, sourceKey }) => ({ providerId, transport, sourceKey })), [
    { providerId: 'company-config', transport: 'ccswitch', sourceKey: 'API2-copy' },
    { providerId: 'approved-backup', transport: 'ccswitch', sourceKey: 'BACKUP' },
  ]);
  assert.equal(f.receipts[1].providerFingerprint, route.providerFingerprint); assert.equal(f.receipts[1].proposalId, route.proposalId);
  assert.equal(f.receipts[1].approvalId, route.approvalId); assert.equal(f.receipts[1].challenge, 7);
  assert.equal(f.receipts[0].ccswitchMode, 'default'); assert.equal(f.receipts[1].ccswitchMode, 'stack');
  route = { route: 'fallback', transport: 'ccswitch', providerId: 'missing-selector', revision: 2 };
  assert.equal((await send(f.gateway)).status, 503);
  route = { route: 'fallback', transport: 'unknown', providerId: 'untrusted-transport', revision: 3 };
  assert.equal((await send(f.gateway)).status, 503);
  assert.equal(f.received.length, 2);
});

test('provider launch paths supply a decoded initial hint while the resolver owns the current route and models stay local', async (t) => {
  const selected = '公司 / API2?copy#selection', hints = [];
  const f = await fixture(t, undefined, { resolveRoute: async (thread, hint) => {
    hints.push({ thread, hint }); return { route: 'fallback', transport: 'ccswitch', providerId: 'current-approved', sourceKey: 'CURRENT', revision: 8 };
  }, officialRequestImpl: () => { assert.fail('models and third-party requests must not open official transport'); } });
  const selectedGateway = { url: f.gateway.url.replace('/v1', `/provider/${encodeURIComponent(selected)}/v1`) };
  assert.equal((await send(selectedGateway)).status, 200);
  assert.deepEqual(hints, [{ thread: A, hint: selected }]);
  assert.equal(f.received[0].body.model, 'ccs-CURRENT/gpt-example');
  await until(() => f.receipts.length === 1); assert.equal(f.receipts[0].providerId, 'current-approved');
  assert.equal((await send(selectedGateway, { path: '/models?client_version=0.163.0', method: 'GET', thread: null, body: null })).status, 200);
  assert.equal(f.received[1].path, '/v1/models?client_version=0.163.0'); assert.equal(hints.length, 1);
  for (const rawPath of [`/${TOKEN}/provider/%ZZ/v1/responses`, `/${TOKEN}/provider/%00/v1/responses`, `/${TOKEN}/provider//v1/responses`,
    `/${TOKEN}/provider/a/b/v1/responses`, `/wrong-capability/provider/${encodeURIComponent(selected)}/v1/responses`]) {
    assert.equal((await send(f.gateway, { rawPath })).status, 404);
  }
  assert.equal(f.received.length, 2);
});

test('official routing preserves the native request at fixed TLS targets and strips local capability metadata', async (t) => {
  const f = await officialFixture(t);
  const body = { ...defaultBody, reasoning: { effort: 'max' }, input: [
    { role: 'user', content: 'synthetic task' }, { type: 'reasoning', encrypted_content: 'synthetic-native-encrypted' },
  ] };
  const result = await send(f.gateway, { body, headers: { 'chatgpt-account-id': 'synthetic-account', referer: f.gateway.url, 'x-original-url': `/${TOKEN}/v1/responses` } });
  assert.equal(result.status, 200); assert.equal(result.body, DONE);
  assert.deepEqual(f.received[0].body, body);
  assert.equal(f.received[0].path, '/backend-api/codex/responses');
  assert.equal(f.officialCalls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(f.officialCalls[0].rejectUnauthorized, true);
  assert.equal(f.officialCalls[0].headers.authorization, AUTH); assert.equal(f.officialCalls[0].headers['chatgpt-account-id'], 'synthetic-account');
  assert.doesNotMatch(JSON.stringify(f.officialCalls), new RegExp(TOKEN));
  await until(() => f.receipts.length === 1);
  assert.equal(f.receipts[0].providerId, 'official-test'); assert.equal(f.receipts[0].transport, 'official'); assert.equal(f.receipts[0].sourceKey, null); assert.equal(f.receipts[0].success, true);
  await send(f.gateway, { path: '/responses/compact', body });
  assert.equal(f.officialCalls[1].url, 'https://chatgpt.com/backend-api/codex/responses/compact');
});

test('unsupported official environments do not block startup, company traffic or models and never silently go direct', async (t) => {
  const original = process.env.ALL_PROXY;
  process.env.ALL_PROXY = 'socks5://synthetic-secret@proxy.invalid:1080';
  try {
    let official = false;
    const f = await officialFixture(t, undefined, { resolveRoute: async () => official
      ? { route: 'fallback', transport: 'official', providerId: 'approved-official', revision: 1 }
      : { route: 'source', transport: 'ccswitch', providerId: 'company-config', sourceKey: 'API2-copy', revision: 0 } });
    assert.equal((await send(f.gateway)).status, 200);
    assert.equal((await send(f.gateway, { path: '/models', method: 'GET', thread: null, body: null })).status, 200);
    official = true;
    const result = await send(f.gateway);
    assert.equal(result.status, 503); assert.match(result.body, /ALL_PROXY/); assert.doesNotMatch(result.body, /synthetic-secret/);
    assert.equal(f.officialCalls.length, 0); assert.equal(f.received.length, 2);
    await until(() => f.receipts.length === 2); assert.equal(f.receipts[1].transport, 'official'); assert.equal(f.receipts[1].success, false);
  } finally { if (original === undefined) delete process.env.ALL_PROXY; else process.env.ALL_PROXY = original; }
});

test('explicit official invalid_encrypted_content rejection permits exactly one reasoning-only repair before downstream output', async (t) => {
  const rejection = JSON.stringify({ error: { code: 'invalid_encrypted_content', param: 'input[0].encrypted_content', message: 'synthetic rejection' } });
  const body = { ...defaultBody, tools: [{ type: 'function', name: 'synthetic_tool' }], input: [
    { type: 'reasoning', encrypted_content: 'synthetic-other-provider-state', summary: [] },
    { role: 'user', content: 'synthetic task' }, { type: 'function_call', call_id: 'synthetic-call', name: 'synthetic_tool', arguments: '{}' },
    { type: 'function_call_output', call_id: 'synthetic-call', output: 'synthetic tool result' },
  ] };
  const f = await officialFixture(t, (_req, res, _seen, index) => {
    res.writeHead(index === 1 ? 400 : 200, { 'content-type': index === 1 ? 'application/json' : 'text/event-stream' });
    res.end(index === 1 ? rejection : DONE);
  });
  const result = await send(f.gateway, { body });
  assert.equal(result.status, 200); assert.equal(result.body, DONE);
  assert.equal(f.received.length, 2); assert.deepEqual(f.received[0].body, body); assert.deepEqual(f.received[1].body, { ...body, input: body.input.slice(1) });
  assert.ok(f.officialCalls.every((call) => call.url === 'https://chatgpt.com/backend-api/codex/responses' && call.headers.authorization === AUTH));
  assert.equal(Number(f.received[1].headers['content-length']), f.received[1].bytes.length);
  await until(() => f.receipts.length === 1); assert.equal(f.receipts[0].statusCode, 200); assert.equal(f.receipts[0].success, true);
});

test('a second encrypted-content rejection is forwarded without a third attempt', async (t) => {
  const rejection = '{"error":{"code":"invalid_encrypted_content","message":"synthetic"}}';
  const f = await officialFixture(t, (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(rejection); });
  const result = await send(f.gateway, { body: { ...defaultBody, input: [{ type: 'reasoning', encrypted_content: 'synthetic' }, ...defaultBody.input] } });
  assert.equal(result.status, 400); assert.equal(result.body, rejection); assert.equal(f.received.length, 2);
  await until(() => f.receipts.length === 1); assert.equal(f.receipts[0].completed, true); assert.equal(f.receipts[0].success, false);
});

test('official ordinary HTTP errors and oversized rejections are returned once unchanged', async (t) => {
  const ordinary = '{"error":{"code":"invalid_request_error","message":"synthetic"}}';
  const large = JSON.stringify({ error: { code: 'invalid_encrypted_content', message: 'synthetic'.repeat(20_000) } });
  const cases = [{ status: 400, body: ordinary }, { status: 403, body: ordinary }, { status: 429, body: ordinary }, { status: 500, body: ordinary },
    { status: 400, body: large }];
  const f = await officialFixture(t, (_req, res, _seen, index) => {
    const result = cases[index - 1]; res.writeHead(result.status, { 'content-type': 'application/json', location: 'https://external.invalid/never-follow' }); res.end(result.body);
  });
  for (const [index, expected] of cases.entries()) {
    const result = await send(f.gateway, { body: { ...defaultBody, input: [{ type: 'reasoning', encrypted_content: 'synthetic' }, ...defaultBody.input] } });
    assert.equal(result.status, expected.status); assert.equal(result.body, expected.body); assert.equal(f.received.length, index + 1);
  }
  assert.ok(f.officialCalls.every(({ url }) => url === 'https://chatgpt.com/backend-api/codex/responses'));
  await until(() => f.receipts.length === cases.length); assert.ok(f.receipts.every((receipt) => !receipt.success));
});

test('every official 3xx becomes 502 without Location so native clients cannot follow or leak identity', async (t) => {
  const statuses = [300, 301, 302, 303, 304, 305, 307, 308, 399];
  const f = await officialFixture(t, (_req, res, _seen, index) => {
    res.writeHead(statuses[index - 1], { location: 'https://external.invalid/never-follow', 'content-type': 'application/json' });
    res.end('{"error":{"code":"invalid_encrypted_content"}}');
  });
  for (const index of statuses.keys()) {
    const result = await send(f.gateway, { body: { ...defaultBody, input: [{ type: 'reasoning', encrypted_content: 'synthetic' }, ...defaultBody.input] } });
    assert.equal(result.status, 502); assert.equal(result.headers.location, undefined);
    assert.match(result.body, /Official redirects are not allowed/); assert.doesNotMatch(result.body, /external\.invalid/);
    assert.equal(f.received.length, index + 1);
  }
  assert.ok(f.officialCalls.every(({ url }) => url === 'https://chatgpt.com/backend-api/codex/responses'));
  await until(() => f.receipts.length === statuses.length);
  assert.ok(f.receipts.every((receipt) => receipt.statusCode === 502 && !receipt.completed && !receipt.success));
});

test('official encrypted task messages and compaction remain intact when rejection cannot be repaired safely', async (t) => {
  const rejection = '{"error":{"code":"invalid_encrypted_content"}}';
  const f = await officialFixture(t, (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(rejection); });
  for (const [index, type] of ['agent_message', 'compaction'].entries()) {
    const body = { ...defaultBody, input: [{ type: 'reasoning', encrypted_content: 'synthetic-reasoning' }, ...defaultBody.input,
      { type, encrypted_content: 'synthetic-task-history' }] };
    const result = await send(f.gateway, { body });
    assert.equal(result.status, 400); assert.equal(result.body, rejection); assert.equal(f.received.length, index + 1);
    assert.deepEqual(f.received[index].body, body);
  }
});

test('an interrupted official error body and an already-streaming SSE error are never retried', async (t) => {
  const f = await officialFixture(t, (_req, res, _seen, index) => {
    if (index === 1) {
      res.writeHead(400, { 'content-type': 'application/json' }); res.write('{"error":{"code":"invalid_encrypted_content"');
      setTimeout(() => res.destroy(), 10);
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: error\ndata: {"error":{"code":"invalid_encrypted_content"}}\n\n');
    }
  });
  const body = { ...defaultBody, input: [{ type: 'reasoning', encrypted_content: 'synthetic' }, ...defaultBody.input] };
  assert.equal((await send(f.gateway, { body })).status, 502);
  assert.equal(f.received.length, 1);
  assert.equal((await send(f.gateway, { body })).status, 200);
  assert.equal(f.received.length, 2);
  await until(() => f.receipts.length === 2); assert.ok(f.receipts.every((receipt) => !receipt.success));
});

test('an unreachable Official upstream reports its socket code and redacted egress in the 502 and the receipt', async t => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const deadPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  let invalidated = 0;
  const f = await fixture(t, undefined, {
    resolveRoute: async () => ({ route: 'fallback', transport: 'official', providerId: 'official-test', revision: 3 }),
    officialNetwork: { resolve: async () => ({ mode: 'auto', source: 'system', proxy: 'http://synthetic-user:synthetic-password@127.0.0.1:7897', proxyEnv: {} }),
      invalidate() { invalidated++; } },
    officialRequestImpl: (target, settings, callback) => httpRequest(`http://127.0.0.1:${deadPort}${target.pathname}`, { method: settings.method, headers: settings.headers, agent: false }, callback),
  });
  const response = await send(f.gateway);
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.body).error.message, 'Official transport is unavailable (ECONNREFUSED; network system: http://***@127.0.0.1:7897)');
  assert.doesNotMatch(response.body, /synthetic-(user|password)/);
  await until(() => f.receipts.length === 1);
  const receipt = f.receipts[0];
  assert.equal(receipt.statusCode, 502); assert.equal(receipt.success, false); assert.equal(receipt.completed, false);
  assert.equal(receipt.transportError, 'ECONNREFUSED'); assert.equal(receipt.networkSource, 'system');
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic|7897/);
  assert.equal(invalidated, 1, 'the next request re-resolves egress');
  assert.equal(f.received.length, 0);
});

test('the network endpoint reports this process egress with a credential-free reachability check', async t => {
  const forced = [];
  const f = await officialFixture(t, (_req, res) => { res.writeHead(405, { 'content-type': 'application/json' }); res.end('{}'); }, {
    officialNetwork: { resolve: async ({ force }) => { forced.push(force); return { mode: 'explicit', source: 'setting',
      proxy: 'http://synthetic-user:synthetic-password@proxy.invalid:8080', proxyEnv: {} }; } },
  });
  const response = await send(f.gateway, { path: '/network', method: 'GET', body: null, thread: null });
  assert.equal(response.status, 200);
  const { official, implementationVersion } = JSON.parse(response.body);
  assert.equal(implementationVersion, GATEWAY_IMPLEMENTATION_VERSION);
  assert.equal(typeof official.elapsedMs, 'number'); delete official.elapsedMs;
  assert.deepEqual(official, { mode: 'explicit', source: 'setting', proxy: 'http://***@proxy.invalid:8080', reachable: true, statusCode: 405 });
  assert.deepEqual(forced, [true], 'the check always re-reads the setting and system proxy');
  assert.deepEqual(f.officialCalls, [{ url: 'https://chatgpt.com/backend-api/codex/responses', headers: {}, rejectUnauthorized: true }],
    'no native authorization or capability reaches the reachability request');
  assert.equal(f.received[0].method, 'GET');
  assert.doesNotMatch(response.body, /synthetic-(user|password)/);
  assert.equal((await send(f.gateway, { path: '/network', body: null, thread: null })).status, 405);
  assert.equal((await send(f.gateway, { rawPath: '/wrong-capability-123456/v1/network', method: 'GET', body: null, thread: null })).status, 404);
  assert.equal((await send(f.gateway, { rawPath: `/${TOKEN}/v1/network?x=1`, method: 'GET', body: null, thread: null })).status, 404);
  assert.equal(f.receipts.length, 0, 'a network check is not a routed request');
});

test('an unsupported Official environment is reported by the network endpoint without failing the gateway', async t => {
  const previous = process.env.ALL_PROXY;
  process.env.ALL_PROXY = 'socks5://synthetic-user:synthetic-password@proxy.invalid:1080';
  t.after(() => { if (previous === undefined) delete process.env.ALL_PROXY; else process.env.ALL_PROXY = previous; });
  const f = await officialFixture(t, undefined, { officialNetwork: { resolve: async () => assert.fail('unsupported environments never resolve egress') } });
  const response = await send(f.gateway, { path: '/network', method: 'GET', body: null, thread: null });
  assert.equal(response.status, 200);
  const { official } = JSON.parse(response.body);
  assert.equal(official.reachable, false); assert.equal(official.error, 'OFFICIAL_TRANSPORT_UNSUPPORTED_ENV');
  assert.match(official.message, /ALL_PROXY/); assert.doesNotMatch(response.body, /synthetic-password/);
  assert.equal(f.officialCalls.length, 0);
});
