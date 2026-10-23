import { createServer, request as httpRequest, Agent } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Transform, pipeline } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { createOfficialTransport, encryptedReasoningRetryBody, redactProxyURL, transportErrorCode } from './official-transport.mjs';
import { createDirectTransport } from './direct-route.mjs';

// A healthy old daemon is not evidence that newly installed forwarding code is running.
export const GATEWAY_IMPLEMENTATION_VERSION = '0.5.0';

// Codex sends zstd request bodies and the Official route needs native proxyEnv.
// Without both, every ordinary request would fail after Codex is pointed here,
// so the gateway refuses to start or connect instead.
export function gatewayRuntimeProblem(nodeVersion = process.versions.node, compression = zlib) {
  const [major, minor] = String(nodeVersion).split('.').map(Number);
  const proxyEnv = major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
  if (proxyEnv && typeof compression.zstdDecompress === 'function') return null;
  return `The local gateway needs Node.js 22.21+ or 24.5+ (zstd request bodies and native proxyEnv); the node that runs it is ${nodeVersion}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const ROUTE_RECEIPT_FIELDS = ['providerFingerprint', 'proposalId', 'approvalId', 'challenge'];
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
  // CCSwitch treats these IDs as provider selectors, including malformed ones.
  // Accepting one from the client would bypass the consent-owned provider and
  // falsely attribute its response to CCSwitch's default route in receipts.
  if (body.model.startsWith('ccs-') && body.model.includes('/')) throw failure(400, 'A plain model ID is required; CCSwitch provider selectors are not accepted');
  if (body.previous_response_id != null && (typeof body.previous_response_id !== 'string' || !body.previous_response_id)) {
    throw failure(400, 'Invalid previous_response_id');
  }
  return { body, bytes };
}

// Validate a streamed JSON value while retaining only protocol metadata. Token
// text, nesting and object keys are bounded; oversized unrelated strings are
// checked and discarded. A truncated prefix is never completion evidence.
function jsonProtocolObserver() {
  const stack = [];
  const metadata = { type: undefined, status: undefined, responseStatus: undefined, error: false };
  // Relevant field names and values fit well within these limits, including
  // fully escaped keys. Other strings are validated without retaining them.
  const TOKEN_LIMIT = 256, DEPTH_LIMIT = 128;
  let invalid = false, rootStarted = false, rootDone = false, token = null;
  const tracked = (parent, key) => {
    if (parent?.role === 'root' && ['type', 'status', 'error'].includes(key)) return key;
    if (parent?.role === 'response' && key === 'status') return 'responseStatus';
    return null;
  };
  const capture = (parent, key, kind, value) => {
    const field = tracked(parent, key);
    if (!field) return;
    if (field === 'error') metadata.error ||= kind !== 'null' && !(kind === 'boolean' && value === false);
    else if (kind === 'string' && typeof value === 'string') metadata[field] = value;
    else invalid = true;
  };
  const complete = () => {
    const parent = stack.at(-1);
    if (parent) { parent.state = 'commaOrEnd'; parent.key = null; }
    else rootDone = true;
  };
  const finishToken = () => {
    const current = token; token = null;
    if (current.kind === 'string') {
      let value;
      if (!current.overflow) { try { value = JSON.parse(current.raw); } catch { invalid = true; return; } }
      if (current.key) {
        const parent = stack.at(-1);
        parent.key = value ?? null; parent.state = 'colon';
        const field = tracked(parent, parent.key);
        if (field || (parent.role === 'root' && parent.key === 'response')) {
          if (parent.seen.has(parent.key)) invalid = true;
          parent.seen.add(parent.key);
        }
      } else { capture(current.parent, current.property, 'string', value); complete(); }
    } else {
      const raw = current.raw;
      if (current.kind === 'number' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(raw)) capture(current.parent, current.property, 'number');
      else if (['true', 'false', 'null'].includes(raw)) capture(current.parent, current.property, raw === 'null' ? 'null' : 'boolean', raw === 'true');
      else { invalid = true; return; }
      complete();
    }
  };
  const startValue = (character) => {
    const parent = stack.at(-1), property = parent?.key;
    if (!parent) {
      if (rootStarted || character !== '{') { invalid = true; return; }
      rootStarted = true;
    }
    if (character === '{' || character === '[') {
      capture(parent, property, 'container');
      if (stack.length >= DEPTH_LIMIT) { invalid = true; return; }
      const role = !parent ? 'root' : parent.role === 'root' && property === 'response' && character === '{' ? 'response' : null;
      stack.push({ kind: character, role, state: character === '{' ? 'keyOrEnd' : 'valueOrEnd', key: null, seen: new Set() });
    } else if (character === '"') {
      token = { kind: 'string', raw: '"', overflow: false, escape: false, unicode: 0, key: false, parent, property };
    } else if (/[-0-9tfn]/.test(character)) {
      token = { kind: /[-0-9]/.test(character) ? 'number' : 'literal', raw: character, parent, property };
    } else invalid = true;
  };
  return {
    write(text) {
      for (let index = 0; index < text.length && !invalid; index++) {
        const character = text[index];
        if (token?.kind === 'string') {
          if (token.raw.length < TOKEN_LIMIT) token.raw += character; else token.overflow = true;
          if (token.unicode) {
            if (!/[0-9a-f]/i.test(character)) invalid = true;
            token.unicode--; continue;
          }
          if (token.escape) {
            token.escape = false;
            if (character === 'u') token.unicode = 4;
            else if (!'"\\/bfnrt'.includes(character)) invalid = true;
          } else if (character === '\\') token.escape = true;
          else if (character === '"') finishToken();
          else if (character.charCodeAt(0) < 32) invalid = true;
          continue;
        }
        if (token) {
          if (' \t\r\n,]}'.includes(character)) { finishToken(); index--; }
          else if (token.raw.length >= TOKEN_LIMIT) invalid = true;
          else token.raw += character;
          continue;
        }
        if (' \t\r\n'.includes(character)) continue;
        if (rootDone) { invalid = true; continue; }
        const parent = stack.at(-1);
        if (!parent) { startValue(character); continue; }
        const close = (expected) => {
          if (character !== expected) { invalid = true; return; }
          stack.pop(); complete();
        };
        if (parent.state === 'keyOrEnd' || parent.state === 'key') {
          if (character === '}' && parent.state === 'keyOrEnd') close('}');
          else if (character === '"') token = { kind: 'string', raw: '"', overflow: false, escape: false, unicode: 0, key: true };
          else invalid = true;
        } else if (parent.state === 'colon') {
          if (character === ':') parent.state = 'value'; else invalid = true;
        } else if (parent.state === 'commaOrEnd') {
          if (character === ',') parent.state = parent.kind === '{' ? 'key' : 'value';
          else close(parent.kind === '{' ? '}' : ']');
        } else if (parent.state === 'valueOrEnd' && character === ']') close(']');
        else startValue(character);
      }
    },
    result() {
      if (token && token.kind !== 'string') finishToken();
      return !invalid && !token && rootDone && !stack.length ? metadata : null;
    },
  };
}

// Observe only bounded protocol metadata; response data never becomes a
// receipt, log, cache, or accumulated transcript.
// An unterminated SSE frame and [DONE] alone are not completion evidence.
function terminalObserver(contentType, encoding) {
  let mode = /^text\/event-stream(?:\s*;|$)/i.test(contentType || '') ? 'sse'
    : /^application\/json(?:\s*;|$)/i.test(contentType || '') ? 'json' : contentType?.trim() ? null : 'sniff';
  const supported = !encoding || String(encoding).toLowerCase() === 'identity';
  const decoder = new StringDecoder('utf8');
  let prefix = '', firstText = true;
  const bodyParser = jsonProtocolObserver();
  let frameParser = jsonProtocolObserver();
  let terminal = null, invalid = false, line = '', lineOverflow = false, dataSeen = false, eventName = '';
  let streamedData = false, pendingCR = '', marker = '', markerOverflow = false;
  const note = (type) => {
    if (FAILURE_EVENTS.has(terminal)) return;
    if (TERMINAL_EVENTS.has(type)) terminal = type;
  };
  const record = (metadata, namedEvent = '', json = false) => {
    const type = metadata.type;
    if (namedEvent && type && namedEvent !== type) invalid = true;
    const observed = TERMINAL_EVENTS.has(namedEvent) ? namedEvent : type;
    if (observed === 'response.completed' && [metadata.status, metadata.responseStatus].some(status => status !== undefined && status !== 'completed')) invalid = true;
    if (metadata.error) { invalid = true; note('error'); }
    else if (TERMINAL_EVENTS.has(observed)) note(observed);
    else if (json && type === undefined && ['completed', 'failed', 'incomplete'].includes(metadata.status)) note(`response.${metadata.status}`);
  };
  const dispatch = () => {
    if (dataSeen) {
      const metadata = frameParser.result();
      if (metadata) record(metadata, eventName);
      else if (markerOverflow || marker.trim() !== '[DONE]') invalid = true;
    }
    frameParser = jsonProtocolObserver(); marker = ''; markerOverflow = false; dataSeen = false; eventName = '';
  };
  const feedData = (part) => {
    frameParser.write(part);
    markerOverflow ||= part.length > 32 - marker.length;
    if (marker.length < 32) marker += part.slice(0, 32 - marker.length);
  };
  const beginData = () => {
    if (dataSeen) feedData('\n');
    dataSeen = true;
  };
  const streamData = (part) => {
    const value = pendingCR + part;
    pendingCR = value.endsWith('\r') ? '\r' : '';
    feedData(pendingCR ? value.slice(0, -1) : value);
  };
  const acceptLine = () => {
    const value = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!value && !lineOverflow) dispatch();
    else if (value.startsWith('event:') && !lineOverflow) eventName = value.slice(6).replace(/^ /, '').slice(0, 128);
    else if (!lineOverflow && (value.startsWith('data:') || value === 'data')) { beginData(); feedData(value.slice(5).replace(/^ /, '')); }
    line = ''; lineOverflow = false; streamedData = false; pendingCR = '';
  };
  const observe = (text) => {
    if (mode === 'json') bodyParser.write(text);
    else if (mode === 'sse') {
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline;
        if (lineOverflow) {
          if (streamedData) streamData(text.slice(start, end));
        } else {
          const available = OBSERVER_LIMIT - line.length;
          line += text.slice(start, Math.min(end, start + available));
          if (end - start > available) {
            lineOverflow = true;
            if (line.startsWith('data:')) {
              beginData(); streamedData = true; streamData(line.slice(5).replace(/^ /, ''));
              streamData(text.slice(start + available, end));
            }
          }
        }
        if (newline < 0) break;
        acceptLine(); start = newline + 1;
      }
    }
  };
  return {
    write(chunk) {
      if (!supported) return;
      let text = decoder.write(chunk);
      if (!text) return;
      if (firstText) { firstText = false; text = text.replace(/^\ufeff/, ''); }
      if (mode === 'sniff') {
        // Some official responses omit Content-Type. Infer only from a bounded
        // leading protocol prefix; never reinterpret an explicit unrelated type.
        const available = OBSERVER_LIMIT - prefix.length;
        prefix += text.slice(0, available);
        const leading = prefix.replace(/^[ \t\r\n]*/, '');
        if (leading.startsWith('{')) mode = 'json';
        else if (leading.startsWith(':') || /^(?:event|data|id|retry):/.test(leading)) mode = 'sse';
        else if (prefix.length === OBSERVER_LIMIT || (leading && !['event:', 'data:', 'id:', 'retry:'].some(value => value.startsWith(leading)))) mode = null;
        if (mode === 'sniff') return;
        observe(prefix); prefix = '';
        observe(text.slice(available));
      } else {
        observe(text);
      }
    },
    end() {
      if (mode === 'json' && supported) {
        bodyParser.write(decoder.end());
        const metadata = bodyParser.result();
        if (metadata) record(metadata, '', true);
      }
      // Compaction and models JSON lack response.completed. They are proxied
      // normally but cannot accidentally satisfy a generation canary.
      line = ''; prefix = '';
    },
    outcome() { return { responseEvent: terminal, success: terminal === 'response.completed' && !invalid }; },
  };
}

// `remote` is the Official transport or a bound direct relay; without it the
// request goes to the local CCSwitch listener.
function proxy(req, res, target, bytes, agent, timeoutMs, query = '', { remote, endpoint, body } = {}) {
  return new Promise((resolve) => {
    let upstream, incoming, observer, ended = false, settled = false, blockedRedirect = false, statusCode = 502, transportError = null;
    const route = remote?.route?.();
    const service = remote ? remote.label || 'Official transport' : 'CCSwitch';
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      res.off('close', disconnected); req.off('aborted', disconnected);
      resolve({ statusCode, completed, ...(observer?.outcome() || { responseEvent: null, success: false }),
        ...(transportError ? { transportError } : {}), ...(route ? { networkSource: route.source } : {}) });
    };
    const disconnected = () => {
      if (res.writableFinished) return;
      upstream?.destroy(); incoming?.destroy();
      finish(false);
    };
    res.once('close', disconnected); req.once('aborted', disconnected);
    if (res.destroyed || req.aborted) { disconnected(); return; }
    const transportFailed = (error) => {
      if (settled || blockedRedirect) return;
      transportError ||= transportErrorCode(error);
      // Re-resolve egress on the next request: the proxy may have changed.
      remote?.failed?.();
      if (res.headersSent) { res.destroy(); finish(false); }
      else {
        if (statusCode !== 504) statusCode = 502;
        res.once('finish', () => finish(false));
        // Error code and redacted egress only; the client (Codex) surfaces this text.
        const detail = remote ? ` (${transportError}; network ${route?.source || 'unknown'}: ${route?.proxy ? redactProxyURL(route.proxy) : 'direct'})` : ` (${transportError})`;
        jsonError(req, res, statusCode, (statusCode === 504 ? `${service} request timed out` : `${service} is unavailable`) + detail);
      }
    };
    const forward = (response, prefix = []) => {
      observer = terminalObserver(response.headers['content-type'], response.headers['content-encoding']);
      res.writeHead(statusCode, cleanHeaders(response.headers));
      const tap = new Transform({ transform(chunk, _encoding, callback) { observer.write(chunk); callback(null, chunk); } });
      for (const chunk of prefix) tap.write(chunk);
      if (response.readableEnded) { ended = true; observer.end(); }
      response.once('end', () => { ended = true; observer.end(); });
      // pipeline preserves bytes and backpressure; failure destroys both ends.
      // Once any response is forwarded, replay is permanently unavailable.
      pipeline(response, tap, res, (error) => finish(!error && ended && response.complete && res.writableFinished));
    };
    const attempt = (payload, retried = false) => {
      if (settled || res.destroyed || req.aborted) { disconnected(); return; }
      statusCode = 502;
      const headers = cleanHeaders(req.headers, { request: true });
      if (payload) headers['content-length'] = String(payload.length);
      const received = (response) => {
        incoming = response; statusCode = response.statusCode || 502;
        if (remote && statusCode >= 300 && statusCode < 400) {
          // Native clients may follow a proxy's Location themselves. Do not let
          // a remote redirect move native Authorization outside the fixed origin.
          blockedRedirect = true; statusCode = 502;
          response.on('error', () => {});
          res.once('finish', () => finish(false));
          jsonError(req, res, 502, `${remote.label || 'Official'} redirects are not allowed`);
          response.destroy();
          return;
        }
        const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
        if (!remote || remote.retriesEncryptedReasoning === false || retried || statusCode !== 400 || encoding !== 'identity'
            || !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) { forward(response); return; }
        // Only a complete, bounded JSON rejection is inspected before sending
        // headers. Large, compressed, partial, and ordinary errors are not retried.
        const prefix = []; let size = 0;
        const cleanup = () => { response.off('data', data); response.off('end', end); response.off('error', failed); response.off('aborted', failed); };
        const failed = (error) => { cleanup(); transportFailed(error); };
        const data = (chunk) => {
          prefix.push(chunk); size += chunk.length;
          if (size > OBSERVER_LIMIT) { response.pause(); cleanup(); forward(response, prefix); }
        };
        const end = () => {
          cleanup();
          if (settled) return;
          let rejection;
          try { rejection = JSON.parse(Buffer.concat(prefix, size).toString('utf8')); } catch { /* Forward invalid/ordinary error bodies unchanged. */ }
          const repaired = response.complete && !res.headersSent ? encryptedReasoningRetryBody(body, rejection) : null;
          if (repaired) { incoming = null; attempt(repaired, true); }
          else forward(response, prefix);
        };
        response.on('data', data); response.once('end', end); response.once('error', failed); response.once('aborted', failed);
      };
      try {
        // The local query never changes the destination/path. Official requests
        // ignore that local URL completely and construct their fixed HTTPS target.
        upstream = remote ? remote.request(endpoint, { method: req.method, headers, query }, received)
          : httpRequest(target, { method: req.method, headers, agent, path: `${target.pathname}${query}` }, received);
      } catch (error) { transportFailed(error); return; }
      const outgoing = upstream;
      outgoing.once('error', (error) => { if (upstream === outgoing) transportFailed(error); });
      outgoing.setTimeout(timeoutMs, () => {
        if (upstream !== outgoing) return;
        if (!res.headersSent) statusCode = 504;
        transportError ||= 'ETIMEDOUT';
        outgoing.destroy(); incoming?.destroy();
      });
      outgoing.end(payload);
    };
    attempt(bytes);
  });
}

/**
 * Session-scoped, capability-protected Responses bridge for CCSwitch routes,
 * Official and direct relays. `url` is a provider base URL ending in
 * /<token>/v1. No auth.json or OAuth flow is involved; the native Authorization
 * goes only to numeric loopback CCSwitch or, for an explicitly resolved official
 * route, the fixed TLS-verified ChatGPT endpoint. A direct relay never receives
 * it: the request carries the consented card's own key and headers instead.
 * An optional /<token>/provider/<encodedProviderId>/v1 prefix supplies an initial
 * provider hint to the resolver; it never determines a remote URL or overrides
 * an existing route. Model listing follows CCSwitch's default card.
 *
 * Continuation state is intentionally in-memory and bounded. A request carrying
 * previous_response_id is accepted only after a successful response on this
 * thread's current route/revision. Restart, eviction, or a route revision change
 * requires a new request with complete input and no previous_response_id. Even
 * input + previous_response_id cannot prove that input contains the full prior
 * context. We reject with 409 instead of silently dropping it or replaying tools.
 * CCSwitch's rectifier receives unaltered input/encrypted content. Official may
 * retry once only after an explicit complete invalid_encrypted_content rejection
 * and only by removing rejected encrypted reasoning, never task/tool history.
 *
 * Receipts contain only the fields constructed below. `completed` means the
 * entire upstream response arrived and the downstream response finished;
 * `success` additionally needs HTTP 2xx and a response.completed terminal event.
 * startedAt/finishedAt are epoch milliseconds; requestId is a fresh UUID.
 */
export async function startSwitchGateway({
  upstream, token, port = 0, resolveRoute, verifyReady, onReceipt = async () => {},
  instanceId = randomUUID(), onShutdown = async () => {},
  officialRequestImpl, officialNetwork = null, resolveDirect = null, resolveModels = null, directTransport = null,
  maxBodyBytes = 32 * 1024 * 1024, bodyTimeoutMs = 30_000, upstreamTimeoutMs = 600_000, maxTrackedThreads = 4096,
} = {}) {
  // CCSwitch's listener; absent while CCSwitch runs no local proxy for Codex.
  const base = upstream == null ? null : upstreamUrl(upstream);
  if (typeof token !== 'string' || !/^[a-z0-9_-]{16,256}$/i.test(token)) throw new Error('A capability token of 16-256 URL-safe characters is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid gateway port');
  if (typeof instanceId !== 'string' || !UUID.test(instanceId)) throw new Error('A UUID gateway instanceId is required');
  if (typeof resolveRoute !== 'function' || typeof verifyReady !== 'function' || typeof onReceipt !== 'function' || typeof onShutdown !== 'function') throw new Error('Gateway callbacks are required');
  positiveInteger(maxBodyBytes, 'maxBodyBytes'); positiveInteger(bodyTimeoutMs, 'bodyTimeoutMs');
  positiveInteger(upstreamTimeoutMs, 'upstreamTimeoutMs'); positiveInteger(maxTrackedThreads, 'maxTrackedThreads');
  const capability = Buffer.from(token), threads = new Map(), sockets = new Set(), receipts = new Set(), handlers = new Set();
  const agent = new Agent({ keepAlive: true });
  let closing = false, origin, closed, shutdownRequested = false, officialTransport;
  const relays = directTransport || createDirectTransport();
  const openOfficial = () => createOfficialTransport({ requestImpl: officialRequestImpl, network: officialNetwork });
  const officialNetworkStatus = async () => {
    let transport;
    try {
      transport = officialTransport ||= openOfficial();
      const route = await transport.prepare({ force: true });
      return { mode: route.mode, source: route.source, proxy: route.proxy ? redactProxyURL(route.proxy) : 'direct',
        ...(route.bypassed ? { bypassed: true } : {}), ...(route.warning ? { warning: route.warning } : {}),
        ...await transport.reachability() };
    } catch (error) {
      // Unsupported runtime/environment messages name variables, never their values.
      return { reachable: false, error: error.code || 'OFFICIAL_TRANSPORT_UNAVAILABLE', message: error.status ? error.message : 'Official transport is unavailable' };
    }
  };
  const endpoint = (req) => {
    if (Object.hasOwn(req.headers, 'origin') || req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Browser-origin requests are not allowed');
    if (req.headers.host !== new URL(origin).host) throw failure(403, 'Invalid gateway host');
    const match = /^\/([^/?#]+)(?:\/provider\/([^/?#]+))?\/v1\/(responses(?:\/compact)?|models|health|network|shutdown)(\?[^#]*)?$/.exec(req.url || '');
    const supplied = Buffer.from(match?.[1] || '');
    if (!match || supplied.length !== capability.length || !timingSafeEqual(supplied, capability)) throw failure(404, 'Unknown gateway endpoint');
    if (match[4] && match[3] !== 'models') throw failure(404, 'Unknown gateway endpoint');
    let initialProviderId;
    if (match[2]) {
      try { initialProviderId = decodeURIComponent(match[2]); } catch { throw failure(404, 'Invalid initial provider path'); }
      if (!initialProviderId || initialProviderId.length > 512 || /[\x00-\x1f\x7f]/.test(initialProviderId)) throw failure(404, 'Invalid initial provider path');
    }
    return { path: match[3], query: match[4] || '', initialProviderId };
  };
  // A loopback relay must be neither this gateway nor CCSwitch's listener,
  // which would silently serve its own default card under this card's name.
  const bindRelay = async (connection) => {
    const loopbackPort = connection.baseURL.protocol === 'http:' ? Number(connection.baseURL.port || 80) : null;
    if (loopbackPort !== null && [Number(new URL(origin).port), Number(base?.port)].includes(loopbackPort)) {
      throw failure(503, 'A relay cannot point at this gateway or at CCSwitch');
    }
    try { return await relays.bind(connection); }
    catch { throw failure(503, 'Relay transport is unavailable'); }
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
      const { path, query, initialProviderId } = endpoint(req);
      if (req.method !== (['models', 'health', 'network'].includes(path) ? 'GET' : 'POST')) throw failure(405, 'Method is not allowed');
      if (path === 'network') {
        // Evaluated in this process: its environment, not the CLI's, decides egress.
        req.resume();
        const official = await officialNetworkStatus();
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, instanceId, implementationVersion: GATEWAY_IMPLEMENTATION_VERSION, official }));
        return;
      }
      if (path === 'health' || path === 'shutdown') {
        // Owned-instance lifecycle only; never mutate CCSwitch or kill a PID.
        req.resume();
        if (path === 'shutdown' && !shutdownRequested) {
          shutdownRequested = true;
          const shutdown = () => { void close().then(() => onShutdown()).catch(() => {}); };
          res.once('finish', shutdown);
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, instanceId, implementationVersion: GATEWAY_IMPLEMENTATION_VERSION }));
        return;
      }
      if (path === 'models') {
        try { if (await verifyReady() === false) throw new Error(); } catch { throw failure(503, 'CCSwitch configuration is not ready'); }
        // Model listing follows CCSwitch's default card, where new conversations
        // start: its relay when it connects directly, otherwise CCSwitch's listener.
        let connection = null;
        try { connection = typeof resolveModels === 'function' ? await resolveModels() : null; }
        catch { throw failure(503, 'CCSwitch\'s default card is unavailable or changed'); }
        if (connection) {
          const remote = await bindRelay(connection);
          await proxy(req, res, null, undefined, agent, upstreamTimeoutMs, query, { remote, endpoint: 'models' }); return;
        }
        if (!base) throw failure(503, 'CCSwitch has no local proxy port for Codex');
        await proxy(req, res, new URL(`${base.href}/models`), undefined, agent, upstreamTimeoutMs, query); return;
      }
      const startedAt = Date.now(), threadId = req.headers['thread-id'];
      if (typeof threadId !== 'string' || !UUID.test(threadId)) throw failure(400, 'A UUID thread-id header is required');
      const normalizedThread = threadId.toLowerCase();
      const { body, bytes } = await jsonBody(req, maxBodyBytes, bodyTimeoutMs);
      let route;
      try { route = await resolveRoute(normalizedThread, initialProviderId); } catch { throw failure(503, 'Session routing is unavailable'); }
      if (!route || !['source', 'fallback'].includes(route.route) || !Number.isSafeInteger(route.revision) || route.revision < 0
          || (route.transport != null && !['ccswitch', 'official', 'direct'].includes(route.transport))
          || (route.ccswitchMode != null && (!['default', 'stack'].includes(route.ccswitchMode) || route.transport !== 'ccswitch'))
          || (route.ccswitchMode === 'default' && !route.providerId)
          || (route.providerId != null && (typeof route.providerId !== 'string' || !route.providerId || route.providerId.length > 512 || /[\x00-\x1f\x7f]/.test(route.providerId)))
          || (route.transport === 'direct' && (!route.providerId || typeof route.providerFingerprint !== 'string' || route.sourceKey != null || route.ccswitchMode != null))
          // A Stack (non-default) CCSwitch route needs its explicit member selector.
          || ((route.transport === 'ccswitch' || route.transport == null) && route.ccswitchMode !== 'default' && (typeof route.sourceKey !== 'string' || !SOURCE_KEY.test(route.sourceKey)))
          || (route.sourceKey != null && (typeof route.sourceKey !== 'string' || !SOURCE_KEY.test(route.sourceKey)))
          || ROUTE_RECEIPT_FIELDS.some((field) => route[field] != null && !(Number.isSafeInteger(route[field])
            || (typeof route[field] === 'string' && route[field].length <= 512 && !/[\x00-\x1f\x7f]/.test(route[field]))))) throw failure(503, 'Session route is invalid');
      // Saved selectors remain part of provider identity. Only CCSwitch's default
      // route, verified against CCSwitch's current default card, has no selector.
      route = Object.freeze({ route: route.route, transport: route.transport || 'ccswitch', providerId: route.providerId ?? null,
        sourceKey: route.transport === 'ccswitch' ? route.sourceKey ?? null : null, revision: route.revision,
        ccswitchMode: route.transport === 'ccswitch' ? route.ccswitchMode ?? (route.sourceKey ? 'stack' : null) : null,
        ...Object.fromEntries(ROUTE_RECEIPT_FIELDS.map((field) => [field, route[field] ?? null])) });
      receipt = { requestId: randomUUID(), threadId: normalizedThread, ...route, startedAt };
      try { if (await verifyReady(route) === false) throw new Error(); } catch { throw failure(503, 'CCSwitch configuration is not ready'); }
      if (res.destroyed || req.aborted || closing) throw failure(503, 'Request was cancelled');
      const identity = JSON.stringify([route.route, route.providerId, route.providerFingerprint, route.transport, route.sourceKey, route.ccswitchMode, route.revision]);
      context = threads.get(normalizedThread);
      if (context?.identity !== identity) context = { identity, established: false };
      threads.delete(normalizedThread); threads.set(normalizedThread, context);
      if (threads.size > maxTrackedThreads) threads.delete(threads.keys().next().value);
      if (body.previous_response_id != null && !context.established) throw failure(409, 'Route continuity is unknown or changed; resend complete input without previous_response_id');
      // CCSwitch's default card takes CCSwitch's ordinary route; another card whose
      // login CCSwitch manages uses its explicit Stack selector.
      const forwarded = route.transport === 'ccswitch' && route.sourceKey && route.ccswitchMode === 'stack'
        ? Buffer.from(JSON.stringify({ ...body, model: `ccs-${route.sourceKey}/${body.model}` })) : bytes;
      let remote;
      // Unsupported official environments never prevent the default company
      // gateway from starting. Selection still belongs entirely to the resolver.
      if (route.transport === 'official') { officialTransport ||= openOfficial(); await officialTransport.prepare(); remote = officialTransport; }
      if (route.transport === 'direct') {
        let connection;
        // Re-read the card for each request; it must still be the consented one.
        try { if (typeof resolveDirect !== 'function') throw new Error(); connection = await resolveDirect(route); }
        catch { throw failure(503, 'The selected relay card is unavailable or changed; switch again'); }
        remote = await bindRelay(connection);
      }
      if (!remote && !base) throw failure(503, 'CCSwitch has no local proxy port for Codex');
      const outcome = await proxy(req, res, remote ? null : new URL(`${base.href}/${path}`), remote ? bytes : forwarded, agent, upstreamTimeoutMs, '',
        remote ? { remote, endpoint: path, body } : undefined);
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
      officialTransport?.close();
      relays.close();
    }).then(async () => {
      await Promise.allSettled([...handlers]);
      await Promise.allSettled([...receipts]);
    });
    return closed;
  }
  return { url: `${origin}/${token}/v1`, port: boundPort, close };
}
