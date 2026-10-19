import { createServer, request as httpRequest, Agent } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Transform, pipeline } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const FAILURE_EVENTS = new Set(['response.failed', 'response.incomplete', 'response.error', 'error']);
const TERMINAL_EVENTS = new Set(['response.completed', ...FAILURE_EVENTS]);
const OBSERVER_LIMIT = 64 * 1024;
const failure = (status, message) => Object.assign(new Error(message), { status });

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

function upstreamUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid local CCSwitch upstream'); }
  // Numeric loopback only: no DNS lookup, proxy environment variables, redirects,
  // credentials in URLs, or caller-selected destinations may receive OAuth auth.
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
    throw new Error('CCSwitch upstream must be an HTTP numeric loopback /v1 URL');
  }
  return new URL(url.href.replace(/\/$/, ''));
}

function cleanHeaders(headers, { request = false } = {}) {
  const omitted = new Set(HOP_HEADERS);
  for (const name of String(headers.connection || '').split(',')) omitted.add(name.trim().toLowerCase());
  if (request) { omitted.add('content-encoding'); omitted.add('expect'); }
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !omitted.has(name.toLowerCase())) result[name] = value;
  }
  if (request) result['accept-encoding'] = 'identity';
  return result;
}

function jsonError(req, res, status, message) {
  req.resume();
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
  res.end(JSON.stringify({ error: { message, type: 'switch_gateway_error' } }));
}

function readBody(req, limit, timeoutMs) {
  if (Number(req.headers['content-length']) > limit) return Promise.reject(failure(413, 'Request body is too large'));
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => finish(failure(408, 'Request body timed out')), timeoutMs);
    timer.unref();
    const finish = (error) => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted);
      if (error) { chunks.length = 0; req.resume(); reject(error); }
      else resolve(Buffer.concat(chunks, bytes));
    };
    const data = (chunk) => { bytes += chunk.length; if (bytes > limit) finish(failure(413, 'Request body is too large')); else chunks.push(chunk); };
    const end = () => finish();
    const failed = () => finish(failure(400, 'Request body was interrupted'));
    const aborted = () => finish(failure(400, 'Request body was interrupted'));
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', aborted);
    if (req.aborted) aborted();
  });
}

async function jsonBody(req, limit, timeoutMs) {
  const type = req.headers['content-type'] || '';
  const charset = /charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(type);
  if (!/^application\/json(?:\s*;|$)/i.test(type) || (charset && !/^utf-?8$/i.test(charset[1] ?? charset[2]))) {
    throw failure(415, 'Only UTF-8 application/json is supported');
  }
  const encoding = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
  const decompress = { gzip: zlib.gunzip, deflate: zlib.inflate, zstd: zlib.zstdDecompress }[encoding];
  if (encoding !== 'identity' && typeof decompress !== 'function') throw failure(415, 'Unsupported request content encoding');
  let bytes = await readBody(req, limit, timeoutMs);
  if (decompress) {
    try { bytes = await promisify(decompress)(bytes, { maxOutputLength: limit }); }
    catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') throw failure(413, 'Decoded request body is too large');
      throw failure(400, 'Invalid compressed request body');
    }
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw failure(400, 'Invalid JSON request body'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw failure(400, 'A JSON object is required');
  if (typeof body.model !== 'string' || !body.model.trim()) throw failure(400, 'A model is required');
  if (body.previous_response_id != null && (typeof body.previous_response_id !== 'string' || !body.previous_response_id)) {
    throw failure(400, 'Invalid previous_response_id');
  }
  return { body, bytes };
}

// Observe only bounded protocol metadata. Large event data is discarded after
// its prefix; it never becomes a receipt, log, cache, or accumulated transcript.
// An unterminated SSE frame and [DONE] alone are not completion evidence.
function terminalObserver(contentType, encoding) {
  const sse = /^text\/event-stream(?:\s*;|$)/i.test(contentType || '');
  const json = /^application\/json(?:\s*;|$)/i.test(contentType || '');
  const supported = !encoding || String(encoding).toLowerCase() === 'identity';
  const decoder = new StringDecoder('utf8');
  let terminal = null, invalid = false, line = '', lineOverflow = false, data = '', dataSeen = false, overflow = false, eventName = '';
  const note = (type) => {
    if (FAILURE_EVENTS.has(terminal)) return;
    if (TERMINAL_EVENTS.has(type)) terminal = type;
  };
  const dispatch = () => {
    if (dataSeen) {
      let payload;
      if (!overflow) { try { payload = JSON.parse(data); } catch { /* Includes the non-terminal [DONE] marker. */ } }
      // Standard Responses streams put type first. Named SSE events also work
      // when response.completed contains a full output larger than our bound.
      const prefixType = overflow ? /^\s*\{\s*"type"\s*:\s*"([^"\\]{1,64})"/.exec(data)?.[1] : undefined;
      const type = payload?.type || prefixType;
      if (TERMINAL_EVENTS.has(eventName) && type && eventName !== type) invalid = true;
      const observed = TERMINAL_EVENTS.has(eventName) ? eventName : type;
      if (observed === 'response.completed' && payload?.response?.status && payload.response.status !== 'completed') invalid = true;
      if (TERMINAL_EVENTS.has(observed) && (overflow || payload)) note(observed);
    }
    data = ''; dataSeen = false; overflow = false; eventName = '';
  };
  const acceptLine = () => {
    const value = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!value && !lineOverflow) dispatch();
    else if (value.startsWith('event:') && !lineOverflow) eventName = value.slice(6).replace(/^ /, '').slice(0, 128);
    else if (value.startsWith('data:')) {
      const part = value.slice(5).replace(/^ /, '');
      if (dataSeen && data.length < OBSERVER_LIMIT) data += '\n';
      const available = OBSERVER_LIMIT - data.length;
      data += part.slice(0, available);
      overflow ||= lineOverflow || part.length > available;
      dataSeen = true;
    }
    line = ''; lineOverflow = false;
  };
  return {
    write(chunk) {
      if (!supported) return;
      const text = decoder.write(chunk);
      if (json) {
        const available = OBSERVER_LIMIT - data.length;
        data += text.slice(0, available); overflow ||= text.length > available;
      } else if (sse) {
        let start = 0;
        while (start < text.length) {
          const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline;
          const available = OBSERVER_LIMIT - line.length;
          line += text.slice(start, Math.min(end, start + available)); lineOverflow ||= end - start > available;
          if (newline < 0) break;
          acceptLine(); start = newline + 1;
        }
      }
    },
    end() {
      if (json && supported && !overflow) {
        let payload;
        try { payload = JSON.parse(data + decoder.end()); } catch { /* No success without a complete JSON response. */ }
        if (payload?.error) note('error');
        else if (['completed', 'failed', 'incomplete'].includes(payload?.status)) note(`response.${payload.status}`);
        else if (TERMINAL_EVENTS.has(payload?.type)) note(payload.type);
      }
      // Compaction and models JSON lack response.completed. They are proxied
      // normally but cannot accidentally satisfy a generation canary.
      data = ''; line = '';
    },
    outcome() { return { responseEvent: terminal, success: terminal === 'response.completed' && !invalid }; },
  };
}

function proxy(req, res, target, bytes, agent, timeoutMs, query = '') {
  return new Promise((resolve) => {
    let upstream, incoming, observer, ended = false, settled = false, statusCode = 502;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      res.off('close', disconnected); req.off('aborted', disconnected);
      resolve({ statusCode, completed, ...(observer?.outcome() || { responseEvent: null, success: false }) });
    };
    const disconnected = () => {
      if (res.writableFinished) return;
      upstream?.destroy(); incoming?.destroy();
      finish(false);
    };
    res.once('close', disconnected); req.once('aborted', disconnected);
    if (res.destroyed || req.aborted) { disconnected(); return; }
    const headers = cleanHeaders(req.headers, { request: true });
    if (bytes) headers['content-length'] = String(bytes.length);
    // The query is appended only after validating the fixed /models endpoint.
    // It is never parsed as a destination URL or allowed to change the path.
    upstream = httpRequest(target, { method: req.method, headers, agent, path: `${target.pathname}${query}` }, (response) => {
      incoming = response; statusCode = response.statusCode || 502;
      observer = terminalObserver(response.headers['content-type'], response.headers['content-encoding']);
      res.writeHead(statusCode, cleanHeaders(response.headers));
      // pipeline preserves bytes and backpressure; failure destroys both ends.
      // There is deliberately no retry, including after HTTP or partial SSE errors.
      const tap = new Transform({ transform(chunk, _encoding, callback) { observer.write(chunk); callback(null, chunk); } });
      response.once('end', () => { ended = true; observer.end(); });
      pipeline(response, tap, res, (error) => finish(!error && ended && response.complete && res.writableFinished));
    });
    upstream.once('error', () => {
      if (settled) return;
      if (res.headersSent) { res.destroy(); finish(false); }
      else {
        res.once('finish', () => finish(false));
        jsonError(req, res, statusCode, statusCode === 504 ? 'CCSwitch request timed out' : 'CCSwitch is unavailable');
      }
    });
    upstream.setTimeout(timeoutMs, () => {
      if (!res.headersSent) statusCode = 504;
      upstream.destroy(); incoming?.destroy();
    });
    upstream.end(bytes);
  });
}

/**
 * Session-scoped, capability-protected Responses bridge to CCSwitch Stack.
 * `url` is a provider base URL ending in /<token>/v1. No auth.json or OAuth flow
 * is involved; Authorization is carried only to the fixed numeric loopback URL.
 *
 * Continuation state is intentionally in-memory and bounded. A request carrying
 * previous_response_id is accepted only after a successful response on this
 * thread's current route/revision. Restart, eviction, or a route revision change
 * requires a new request with complete input and no previous_response_id. Even
 * input + previous_response_id cannot prove that input contains the full prior
 * context. We reject with 409 instead of silently dropping it or replaying tools.
 * CCSwitch's own rectifier receives the unaltered input and encrypted content.
 *
 * Receipts contain only the fields constructed below. `completed` means the
 * entire upstream response arrived and the downstream response finished;
 * `success` additionally needs HTTP 2xx and a response.completed terminal event.
 * startedAt/finishedAt are epoch milliseconds; requestId is a fresh UUID.
 */
export async function startSwitchGateway({
  upstream, token, port = 0, resolveRoute, verifyReady, onReceipt = async () => {},
  instanceId = randomUUID(), onShutdown = async () => {},
  maxBodyBytes = 32 * 1024 * 1024, bodyTimeoutMs = 30_000, upstreamTimeoutMs = 600_000, maxTrackedThreads = 4096,
} = {}) {
  const base = upstreamUrl(upstream);
  if (typeof token !== 'string' || !/^[a-z0-9_-]{16,256}$/i.test(token)) throw new Error('A capability token of 16-256 URL-safe characters is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid gateway port');
  if (typeof instanceId !== 'string' || !UUID.test(instanceId)) throw new Error('A UUID gateway instanceId is required');
  if (typeof resolveRoute !== 'function' || typeof verifyReady !== 'function' || typeof onReceipt !== 'function' || typeof onShutdown !== 'function') throw new Error('Gateway callbacks are required');
  positiveInteger(maxBodyBytes, 'maxBodyBytes'); positiveInteger(bodyTimeoutMs, 'bodyTimeoutMs');
  positiveInteger(upstreamTimeoutMs, 'upstreamTimeoutMs'); positiveInteger(maxTrackedThreads, 'maxTrackedThreads');
  const capability = Buffer.from(token), threads = new Map(), sockets = new Set(), receipts = new Set(), handlers = new Set();
  const agent = new Agent({ keepAlive: true });
  let closing = false, origin, closed, shutdownRequested = false;
  const endpoint = (req) => {
    if (Object.hasOwn(req.headers, 'origin') || req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Browser-origin requests are not allowed');
    if (req.headers.host !== new URL(origin).host) throw failure(403, 'Invalid gateway host');
    const match = /^\/([^/?#]+)\/v1\/(responses(?:\/compact)?|models|health|shutdown)(\?[^#]*)?$/.exec(req.url || '');
    const supplied = Buffer.from(match?.[1] || '');
    if (!match || supplied.length !== capability.length || !timingSafeEqual(supplied, capability)) throw failure(404, 'Unknown gateway endpoint');
    if (match[3] && match[2] !== 'models') throw failure(404, 'Unknown gateway endpoint');
    return { path: match[2], query: match[3] || '' };
  };
  const emitReceipt = (receipt) => {
    // Callback failures cannot alter a finished response or cause a replay.
    const pending = Promise.resolve().then(() => onReceipt(Object.freeze(receipt))).catch(() => {});
    receipts.add(pending); pending.finally(() => receipts.delete(pending));
  };
  const server = createServer(async (req, res) => {
    let settleHandler;
    const handled = new Promise((resolve) => { settleHandler = resolve; });
    handlers.add(handled);
    let receipt, context;
    try {
      if (closing) throw failure(503, 'Gateway is closing');
      const { path, query } = endpoint(req);
      if (req.method !== (['models', 'health'].includes(path) ? 'GET' : 'POST')) throw failure(405, 'Method is not allowed');
      if (path === 'health' || path === 'shutdown') {
        // Owned-instance lifecycle only; never mutate CCSwitch or kill a PID.
        req.resume();
        if (path === 'shutdown' && !shutdownRequested) {
          shutdownRequested = true;
          const shutdown = () => { void close().then(() => onShutdown()).catch(() => {}); };
          res.once('finish', shutdown);
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, instanceId }));
        return;
      }
      if (path === 'models') {
        try { if (await verifyReady() === false) throw new Error(); } catch { throw failure(503, 'CCSwitch configuration is not ready'); }
        await proxy(req, res, new URL(`${base.href}/models`), undefined, agent, upstreamTimeoutMs, query); return;
      }
      const startedAt = Date.now(), threadId = req.headers['thread-id'];
      if (typeof threadId !== 'string' || !UUID.test(threadId)) throw failure(400, 'A UUID thread-id header is required');
      const normalizedThread = threadId.toLowerCase();
      const { body, bytes } = await jsonBody(req, maxBodyBytes, bodyTimeoutMs);
      let route;
      try { route = await resolveRoute(normalizedThread); } catch { throw failure(503, 'Session routing is unavailable'); }
      if (!route || !['source', 'fallback'].includes(route.route) || !Number.isSafeInteger(route.revision) || route.revision < 0
          || (route.route === 'source' && (typeof route.sourceKey !== 'string' || !SOURCE_KEY.test(route.sourceKey)))) throw failure(503, 'Session route is invalid');
      route = { route: route.route, sourceKey: route.sourceKey, revision: route.revision };
      receipt = { requestId: randomUUID(), threadId: normalizedThread, route: route.route, revision: route.revision, startedAt };
      try { if (await verifyReady() === false) throw new Error(); } catch { throw failure(503, 'CCSwitch configuration is not ready'); }
      if (res.destroyed || req.aborted || closing) throw failure(503, 'Request was cancelled');
      const identity = JSON.stringify([route.route, route.sourceKey || null, route.revision]);
      context = threads.get(normalizedThread);
      if (context?.identity !== identity) context = { identity, established: false };
      threads.delete(normalizedThread); threads.set(normalizedThread, context);
      if (threads.size > maxTrackedThreads) threads.delete(threads.keys().next().value);
      if (body.previous_response_id != null && !context.established) throw failure(409, 'Route continuity is unknown or changed; resend complete input without previous_response_id');
      // The only semantic request change: Stack's explicit source selector.
      // Fallback bytes stay untouched (apart from bounded decompression).
      const forwarded = route.route === 'source' ? Buffer.from(JSON.stringify({ ...body, model: `ccs-${route.sourceKey}/${body.model}` })) : bytes;
      const outcome = await proxy(req, res, new URL(`${base.href}/${path}`), forwarded, agent, upstreamTimeoutMs);
      const success = outcome.completed && outcome.success && outcome.statusCode >= 200 && outcome.statusCode < 300;
      if (success && threads.get(normalizedThread) === context) context.established = true;
      emitReceipt({ ...receipt, ...outcome, success, finishedAt: Date.now() }); receipt = null;
    } catch (error) {
      const statusCode = error.status || 502;
      jsonError(req, res, statusCode, error.status ? error.message : 'Gateway request failed');
      if (receipt) {
        const record = () => emitReceipt({ ...receipt, statusCode, completed: false, success: false, responseEvent: null, finishedAt: Date.now() });
        if (res.destroyed || res.writableFinished) record();
        else { let recorded = false; const once = () => { if (!recorded) { recorded = true; record(); } }; res.once('finish', once); res.once('close', once); }
      }
    } finally {
      settleHandler(); handlers.delete(handled);
    }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket) => {
    let status = 426;
    try { endpoint(req); } catch (error) { status = error.status || 400; }
    // CCSwitch's Responses route is SSE-only. Explicit refusal prevents an
    // upgraded connection from bypassing thread routing and receipt validation.
    const messages = { 426: 'Upgrade Required', 403: 'Forbidden', 404: 'Not Found', 400: 'Bad Request' };
    socket.end(`HTTP/1.1 ${status} ${messages[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { agent.destroy(); throw error; }
  const boundPort = server.address().port;
  origin = `http://127.0.0.1:${boundPort}`;
  function close() {
    if (closed) return closed;
    closing = true;
    closed = new Promise((resolve) => {
      server.close(resolve);
      for (const socket of sockets) socket.destroy();
      agent.destroy();
    }).then(async () => {
      await Promise.allSettled([...handlers]);
      await Promise.allSettled([...receipts]);
    });
    return closed;
  }
  return { url: `${origin}/${token}/v1`, port: boundPort, close };
}
