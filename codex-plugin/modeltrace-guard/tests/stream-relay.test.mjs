import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { drainingRelay } from '../scripts/stream-relay.mjs';

test('the draining relay also serves the gateway base path and forwards only the models query', async t => {
  const seen = [];
  const upstream = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const base = `/${'a'.repeat(64)}/v1`;
  const relay = await drainingRelay(new URL(`http://127.0.0.1:${upstream.address().port}${base}`));
  t.after(() => relay.close());
  assert.equal((await fetch(`${relay.url}/models?client_version=0.163.0`)).status, 200);
  assert.equal((await fetch(`${relay.url}/responses`, { method: 'POST', body: '{}' })).status, 200);
  for (const [suffix, method] of [['/responses?url=http://external.invalid', 'POST'], ['/models', 'POST'], ['/responses', 'GET'], ['//external.invalid/responses', 'POST'], ['/health', 'GET']]) {
    assert.equal((await fetch(`${relay.url}${suffix}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) })).status, 404, suffix);
  }
  assert.deepEqual(seen, [`GET ${base}/models?client_version=0.163.0`, `POST ${base}/responses`]);
  await relay.close(); await relay.close();
});
