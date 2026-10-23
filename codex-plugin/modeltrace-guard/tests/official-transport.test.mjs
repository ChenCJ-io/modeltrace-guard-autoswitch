import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootCertificates } from 'node:tls';
import { createServer } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { EventEmitter } from 'node:events';
import { createOfficialTransport, encryptedReasoningRetryBody } from '../scripts/official-transport.mjs';

function fakeTransport(options = {}) {
  const calls = [], agents = [];
  const transport = createOfficialTransport({ env: {}, nodeVersion: '25.6.1',
    agentFactory: (settings) => { const agent = { settings, destroyed: 0, destroy() { this.destroyed++; } }; agents.push(agent); return agent; },
    requestImpl: (url, settings, callback) => { const call = { url, settings, callback }; calls.push(call); return call; }, ...options });
  return { transport, calls, agents };
}

test('official requests have a fixed HTTPS destination, retain native identity, and cannot carry the local capability path', () => {
  const f = fakeTransport(), callback = () => {};
  const headers = { authorization: 'Bearer synthetic-native-token', 'chatgpt-account-id': 'synthetic-account', 'thread-id': 'synthetic-thread',
    host: 'external.invalid', referer: 'http://127.0.0.1/private-capability/v1', forwarded: 'host=private-capability',
    'x-original-url': '/private-capability/v1/responses', 'proxy-authorization': 'synthetic-proxy-credentials' };
  f.transport.request('responses', { headers, host: 'external.invalid', path: '/private-capability', rejectUnauthorized: false }, callback);
  f.transport.request('responses/compact', { headers }, callback);
  assert.deepEqual(f.calls.map((call) => call.url.href), ['https://chatgpt.com/backend-api/codex/responses', 'https://chatgpt.com/backend-api/codex/responses/compact']);
  for (const call of f.calls) {
    assert.equal(call.settings.agent, f.agents[0]); assert.equal(call.settings.rejectUnauthorized, true); assert.equal(call.callback, callback);
    assert.deepEqual(call.settings.headers, { authorization: headers.authorization, 'chatgpt-account-id': headers['chatgpt-account-id'], 'thread-id': headers['thread-id'] });
    assert.doesNotMatch(JSON.stringify(call), /private-capability|external\.invalid|proxy-credentials/);
  }
  for (const endpoint of ['models', 'responses?url=https://external.invalid', '//external.invalid/responses', 'https://external.invalid/responses', 'responses/../models']) {
    assert.throws(() => f.transport.request(endpoint, { headers }), /Unsupported official endpoint/);
  }
  assert.throws(() => f.transport.request('responses', { method: 'GET', headers }), /Unsupported official endpoint/);
  assert.equal(f.calls.length, 2);
  f.transport.close(); f.transport.close(); assert.equal(f.agents[0].destroyed, 1);
  assert.throws(() => f.transport.request('responses'), /closed/);
});

test('native proxy environment and verified TLS reach the HTTPS Agent without exposing proxy auth in request headers', () => {
  const env = { HTTPS_PROXY: 'http://synthetic-user:synthetic-password@proxy.invalid:8080', HTTP_PROXY: 'http://proxy.invalid:8080', NO_PROXY: 'localhost,127.0.0.1' };
  const f = fakeTransport({ env });
  assert.equal(f.agents[0].settings.proxyEnv, env);
  assert.equal(f.agents[0].settings.rejectUnauthorized, true);
  assert.equal(f.agents[0].settings.ca, undefined);
  f.transport.request('responses', { headers: { authorization: 'Bearer synthetic-native-token' } });
  assert.doesNotMatch(JSON.stringify(f.calls[0].settings.headers), /proxy|password/);
  f.transport.close();
});

test('the real HTTPS Agent honors HTTPS_PROXY using only a synthetic CONNECT proxy', async (t) => {
  const connects = [];
  const proxy = createServer();
  proxy.on('connect', (req, socket) => {
    connects.push({ target: req.url, headers: req.headers });
    socket.end('HTTP/1.1 502 Synthetic Proxy Rejection\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const transport = createOfficialTransport({ env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` },
    // If proxy support regresses, prevent even a DNS lookup or real connection.
    agentFactory: (settings) => new HttpsAgent({ ...settings, lookup: (_hostname, _options, callback) => callback(new Error('Unexpected direct DNS lookup')) }),
  });
  t.after(() => transport.close());
  await new Promise((resolve) => {
    const req = transport.request('responses', { headers: { authorization: 'Bearer synthetic-native-token' } }, (res) => { res.resume(); res.once('end', resolve); });
    req.once('error', resolve); req.setTimeout(1000, () => req.destroy(new Error('Synthetic proxy timeout'))); req.end('{}');
  });
  assert.equal(connects.length, 1); assert.equal(connects[0].target, 'chatgpt.com:443');
  assert.equal(connects[0].headers.authorization, undefined);
});

test('a network resolver selects egress per request and keeps superseded agents for in-flight streams', async () => {
  let route = { mode: 'auto', source: 'system', proxy: 'http://127.0.0.1:7897', proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:7897' } };
  let invalidated = 0;
  const f = fakeTransport({ network: { resolve: async () => route, invalidate() { invalidated++; } } });
  assert.equal(f.agents.length, 0, 'no agent exists before the route is resolved');
  assert.throws(() => f.transport.request('responses', { headers: {} }), /not been prepared/);
  assert.equal((await f.transport.prepare()).source, 'system');
  f.transport.request('responses', { headers: {} });
  assert.deepEqual(f.agents[0].settings.proxyEnv, { HTTPS_PROXY: 'http://127.0.0.1:7897' });
  assert.equal(f.calls[0].settings.agent, f.agents[0]);
  route = { mode: 'auto', source: 'direct', proxy: null, proxyEnv: {} };
  await f.transport.prepare();
  f.transport.request('responses', { headers: {} });
  assert.equal(f.calls[1].settings.agent, f.agents[1]); assert.deepEqual(f.agents[1].settings.proxyEnv, {});
  assert.equal(f.agents[0].destroyed, 0, 'a superseded route is not torn down under a streaming response');
  await f.transport.prepare();
  assert.equal(f.agents.length, 2, 'an unchanged route reuses its keep-alive agent');
  assert.equal(f.transport.route().source, 'direct');
  f.transport.failed(); assert.equal(invalidated, 1);
  f.transport.close(); assert.deepEqual(f.agents.map(agent => agent.destroyed), [1, 1]);
  await assert.rejects(() => f.transport.prepare(), /closed/);
});

test('an unusable saved network setting fails explicitly instead of going direct', async () => {
  const f = fakeTransport({ network: { resolve: async () => { throw Object.assign(new Error('Official proxy must be auto, direct, or an http(s)://host:port URL'), { code: 'INVALID_OFFICIAL_PROXY' }); } } });
  await assert.rejects(() => f.transport.prepare(), error => error.status === 503 && error.code === 'OFFICIAL_NETWORK_UNAVAILABLE' && /http\(s\)/.test(error.message));
  assert.throws(() => f.transport.request('responses', { headers: {} }), /not been prepared/);
});

test('reachability is a header-free GET reporting the HTTP status or only the socket error code', async () => {
  const seen = [];
  const transportWith = (behavior) => createOfficialTransport({ env: {}, nodeVersion: '25.6.1', agentFactory: () => ({ destroy() {} }),
    requestImpl: (url, settings, callback) => {
      seen.push({ url: url.href, settings });
      const req = new EventEmitter();
      req.setTimeout = () => req; req.destroy = () => {};
      req.end = () => setImmediate(() => behavior === 'ok' ? callback({ statusCode: 405, resume() {} })
        : req.emit('error', Object.assign(new Error('reset by http://synthetic-user:synthetic-password@proxy.invalid'), { code: 'ECONNRESET' })));
      return req;
    } });
  const ok = await transportWith('ok').reachability();
  assert.equal(ok.reachable, true); assert.equal(ok.statusCode, 405);
  assert.equal(seen[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(seen[0].settings.method, 'GET'); assert.deepEqual(seen[0].settings.headers, {}); assert.equal(seen[0].settings.rejectUnauthorized, true);
  const down = await transportWith('reset').reachability();
  assert.equal(down.reachable, false); assert.equal(down.error, 'ECONNRESET');
  assert.doesNotMatch(JSON.stringify(down), /synthetic-password/);
  const unprepared = fakeTransport({ network: { resolve: async () => ({}) } });
  assert.deepEqual((({ reachable, error }) => ({ reachable, error }))(await unprepared.transport.reachability()), { reachable: false, error: 'ROUTE_NOT_PREPARED' });
});

test('the real HTTPS Agent tunnels a resolved system proxy route even without proxy environment variables', async (t) => {
  const connects = [];
  const proxy = createServer();
  proxy.on('connect', (req, socket) => {
    connects.push({ target: req.url, headers: req.headers });
    socket.end('HTTP/1.1 502 Synthetic Proxy Rejection\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const transport = createOfficialTransport({ env: {}, network: { resolve: async () => ({ mode: 'auto', source: 'system', proxy: url, proxyEnv: { HTTPS_PROXY: url } }) },
    agentFactory: (settings) => new HttpsAgent({ ...settings, lookup: (_hostname, _options, callback) => callback(new Error('Unexpected direct DNS lookup')) }) });
  t.after(() => transport.close());
  await transport.prepare();
  const result = await transport.reachability({ timeoutMs: 2000 });
  assert.equal(result.reachable, false);
  assert.equal(connects.length, 1); assert.equal(connects[0].target, 'chatgpt.com:443');
  assert.equal(connects[0].headers.authorization, undefined);
});

test('unsupported runtime, ALL_PROXY, native-client custom CA and insecure TLS settings fail explicitly', () => {
  for (const nodeVersion of ['18.20.0', '20.19.0', '22.20.0', '23.11.0', '24.4.0']) {
    assert.throws(() => fakeTransport({ nodeVersion }), (error) => error.status === 503 && /proxyEnv/.test(error.message));
  }
  for (const nodeVersion of ['22.21.0', '24.5.0', '25.0.0', '26.0.0']) fakeTransport({ nodeVersion }).transport.close();
  for (const variable of ['ALL_PROXY', 'all_proxy', 'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CODEX_NETWORK_PROXY_ACTIVE']) {
    assert.throws(() => fakeTransport({ env: { [variable]: 'synthetic-secret-setting' } }), (error) => error.status === 503 && error.message.includes(variable) && !error.message.includes('synthetic-secret-setting'));
  }
  assert.throws(() => fakeTransport({ env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }), /TLS certificate verification/);
  assert.throws(() => fakeTransport({ env: { HTTPS_PROXY: 'socks5://synthetic-user:synthetic-password@proxy.invalid' } }), (error) => /proxy protocol/.test(error.message) && !error.message.includes('synthetic-password'));
  assert.throws(() => fakeTransport({ env: { HTTPS_PROXY: 'synthetic-malformed-proxy' } }), /invalid HTTPS_PROXY/);
});

test('NODE_EXTRA_CA_CERTS loaded at process startup is retained by the official HTTPS agent', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'official-transport-ca-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certificate = path.join(directory, 'synthetic-extra-ca.pem');
  await writeFile(certificate, rootCertificates[0]);
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: certificate };
  for (const key of ['ALL_PROXY', 'all_proxy', 'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CODEX_NETWORK_PROXY_ACTIVE', 'NODE_TLS_REJECT_UNAUTHORIZED', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete env[key];
  const source = `import { createOfficialTransport } from ${JSON.stringify(new URL('../scripts/official-transport.mjs', import.meta.url).href)};
    const transport = createOfficialTransport(); transport.close(); console.log('extra-ca-retained');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'extra-ca-retained');
});

test('encrypted reasoning repair preserves every task and tool item and all other request fields', () => {
  const body = { model: 'synthetic-model', stream: true, tools: [{ type: 'function', name: 'synthetic_tool' }], reasoning: { effort: 'max' },
    input: [{ type: 'reasoning', encrypted_content: 'synthetic-private-reasoning', summary: [] },
      { role: 'user', content: 'synthetic user task' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic message' }] },
      { type: 'function_call', call_id: 'synthetic-call', name: 'synthetic_tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'synthetic-call', output: 'synthetic tool result' }, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'retain plain summary' }] }] };
  const before = JSON.stringify(body);
  const result = encryptedReasoningRetryBody(body, { error: { code: 'invalid_encrypted_content', param: 'input[0].encrypted_content' } });
  assert.deepEqual(JSON.parse(result), { ...body, input: body.input.slice(1) });
  assert.equal(JSON.stringify(body), before);
});

test('ordinary errors, provider-private task history and continuation-only context are never stripped or retried', () => {
  const reasoning = { type: 'reasoning', encrypted_content: 'synthetic' }, task = { role: 'user', content: 'retain task' };
  const rejection = { error: { code: 'invalid_encrypted_content' } };
  for (const body of [{ input: [reasoning] }, { input: [task] }, { input: 'task' }, { previous_response_id: 'resp-synthetic' },
    { input: [reasoning, task], previous_response_id: 'resp-synthetic' },
    { input: [reasoning, task, { type: 'agent_message', encrypted_content: 'synthetic-private-message' }] },
    { input: [reasoning, task, { type: 'compaction', encrypted_content: 'synthetic-private-compaction' }] },
    { input: [reasoning, task, { type: 'message', content: [{ encrypted_content: 'synthetic-private-content' }] }] }]) {
    assert.equal(encryptedReasoningRetryBody(body, rejection), null);
  }
  for (const error of [{ code: 'invalid_request_error' }, { message: 'invalid_encrypted_content' }, { code: 'invalid_encrypted_content', param: 'input[1].encrypted_content' }]) {
    assert.equal(encryptedReasoningRetryBody({ input: [reasoning, task] }, { error }), null);
  }
});
