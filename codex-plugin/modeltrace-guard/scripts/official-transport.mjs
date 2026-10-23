import { Agent, request as httpsRequest } from 'node:https';
import * as tls from 'node:tls';

export const OFFICIAL_HOST = 'chatgpt.com';
const OFFICIAL_BASE = `https://${OFFICIAL_HOST}/backend-api/codex/`;
const unsupported = (message) => Object.assign(new Error(message), { status: 503, code: 'OFFICIAL_TRANSPORT_UNSUPPORTED_ENV' });
// Socket/TLS/proxy error codes only (ECONNRESET, ERR_PROXY_TUNNEL, ...): never a
// message, which can echo a proxy URL with credentials.
export const transportErrorCode = (error) => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'TRANSPORT_ERROR';
// Proxy credentials never reach a response body, receipt or status output.
export function redactProxyURL(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) { url.username = '***'; url.password = ''; }
    return url.href.replace(/\/$/, '');
  } catch { return '<invalid>'; }
}
const MAX_ROUTE_AGENTS = 8;
const PRIVATE_HEADERS = new Set(['host', 'connection', 'proxy-authorization', 'proxy-authenticate', 'origin', 'referer', 'referrer',
  'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-uri', 'x-original-url', 'x-rewrite-url']);

function officialEnvironment(env, nodeVersion) {
  const [major, minor] = String(nodeVersion).split('.').map(Number);
  if (!(major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21))) {
    throw unsupported('Official transport requires Node 22.21+ or 24.5+ with native proxyEnv support');
  }
  // Node's native HTTP proxy support does not interpret ALL_PROXY or these
  // native-client CA settings. Refuse explicitly instead of silently going direct
  // or using a different trust store. No proxy credentials enter an error message.
  for (const name of ['ALL_PROXY', 'all_proxy', 'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CODEX_NETWORK_PROXY_ACTIVE']) {
    if (env[name]) throw unsupported(`Official transport cannot reproduce ${name}; use supported HTTPS_PROXY / NODE_EXTRA_CA_CERTS settings`);
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw unsupported('Official transport requires TLS certificate verification');
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (!env[name]) continue;
    let proxy;
    try { proxy = new URL(env[name]); } catch { throw unsupported(`Official transport has an invalid ${name} setting`); }
    if (!['http:', 'https:'].includes(proxy.protocol)) throw unsupported(`Official transport does not support the ${name} proxy protocol`);
  }
  // NODE_EXTRA_CA_CERTS is loaded by Node at process startup, not per request.
  // An invalid file or late environment mutation must not silently lose custom CA.
  if (env.NODE_EXTRA_CA_CERTS && (!tls.getCACertificates || tls.getCACertificates('extra').length === 0)) {
    throw unsupported('Official transport requires NODE_EXTRA_CA_CERTS to be loaded successfully at Node startup');
  }
}

/**
 * Fixed official destination; test injection never becomes a CLI URL override.
 * Without `network`, the process environment is the only proxy source. With a
 * `network` resolver (network-route.mjs), callers `prepare()` before each
 * request so the egress route follows the saved setting / system proxy.
 */
export function createOfficialTransport({ requestImpl = httpsRequest, env = process.env, nodeVersion = process.versions.node,
  agentFactory = (options) => new Agent(options), network = null } = {}) {
  officialEnvironment(env, nodeVersion);
  if (typeof requestImpl !== 'function' || typeof agentFactory !== 'function') throw new Error('Invalid official transport dependencies');
  if (network && typeof network.resolve !== 'function') throw new Error('Invalid official network resolver');
  // One keep-alive agent per egress route. Agents of a superseded route are not
  // destroyed while their in-flight requests may still be streaming.
  const agents = new Map();
  const agentFor = (key, proxyEnv) => {
    if (!agents.has(key)) {
      agents.set(key, agentFactory({ keepAlive: true, proxyEnv, rejectUnauthorized: true }));
      if (agents.size > MAX_ROUTE_AGENTS) { const [oldest] = agents.keys(); agents.get(oldest).destroy(); agents.delete(oldest); }
    }
    return agents.get(key);
  };
  let closed = false;
  let current = network ? null : { agent: agentFor('environment', env), route: { mode: 'environment', source: 'environment', proxy: null } };
  return {
    async prepare({ force = false } = {}) {
      if (closed) throw unsupported('Official transport is closed');
      if (!network) return current.route;
      let route;
      try { route = await network.resolve({ force }); }
      catch (error) {
        throw Object.assign(new Error(`Official network setting is unusable: ${error.code === 'INVALID_OFFICIAL_PROXY' ? error.message : 'resolution failed'}`),
          { status: 503, code: 'OFFICIAL_NETWORK_UNAVAILABLE' });
      }
      if (closed) throw unsupported('Official transport is closed');
      current = { agent: agentFor(JSON.stringify([route.source, route.proxy]), route.proxyEnv), route };
      return route;
    },
    route() { return current?.route || null; },
    // A failed connection re-resolves the route on the next request.
    failed() { network?.invalidate?.(); },
    request(endpoint, { method = 'POST', headers = {} } = {}, callback) {
      if (closed) throw unsupported('Official transport is closed');
      if (!current) throw unsupported('Official network route has not been prepared');
      if (!['responses', 'responses/compact'].includes(endpoint) || method !== 'POST') throw new Error('Unsupported official endpoint');
      const safeHeaders = {};
      const omitted = new Set(PRIVATE_HEADERS);
      for (const name of String(headers.connection || '').split(',')) omitted.add(name.trim().toLowerCase());
      for (const [name, value] of Object.entries(headers)) if (!omitted.has(name.toLowerCase()) && value !== undefined) safeHeaders[name] = value;
      // https.request does not follow redirects. The capability path is never
      // passed here, and caller host/path/agent/TLS options are intentionally ignored.
      const target = new URL(endpoint, OFFICIAL_BASE);
      return requestImpl(target, { method, headers: safeHeaders, agent: current.agent, rejectUnauthorized: true }, callback);
    },
    // Credential-free GET without any header: any HTTP status proves that TLS to
    // the fixed origin works over the current route. No inference is performed.
    reachability({ timeoutMs = 8000 } = {}) {
      const started = Date.now();
      return new Promise((resolve) => {
        let done = false;
        const finish = (result) => { if (!done) { done = true; resolve({ ...result, elapsedMs: Date.now() - started }); } };
        if (closed || !current) { finish({ reachable: false, error: closed ? 'TRANSPORT_CLOSED' : 'ROUTE_NOT_PREPARED' }); return; }
        let req;
        try {
          req = requestImpl(new URL('responses', OFFICIAL_BASE), { method: 'GET', headers: {}, agent: current.agent, rejectUnauthorized: true },
            (res) => { finish({ reachable: true, statusCode: res.statusCode }); res.resume(); });
        } catch (error) { finish({ reachable: false, error: transportErrorCode(error) }); return; }
        req.once('error', (error) => finish({ reachable: false, error: transportErrorCode(error) }));
        req.setTimeout(timeoutMs, () => { finish({ reachable: false, error: 'ETIMEDOUT' }); req.destroy(); });
        req.end();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const agent of agents.values()) agent.destroy();
      agents.clear();
    },
  };
}

function hasEncryptedContent(value) {
  if (!value || typeof value !== 'object') return false;
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    for (const [key, item] of Object.entries(current)) {
      if (key === 'encrypted_content' && item != null && item !== '') return true;
      if (item && typeof item === 'object') pending.push(item);
    }
  }
  return false;
}

/**
 * Only a fully received official HTTP 400 error with this exact code authorizes
 * one repair attempt. The caller owns the HTTP/stream/retry-count checks.
 * Reasoning is normally preserved. This exception removes rejected encrypted
 * reasoning items only; user, assistant, tool and function items remain intact.
 * We cannot reconstruct provider-private messages, compaction, or server-side
 * continuation history, so those cases remain an error instead of losing work.
 */
export function encryptedReasoningRetryBody(body, rejection) {
  if (rejection?.error?.code !== 'invalid_encrypted_content' || !Array.isArray(body?.input) || body.previous_response_id != null) return null;
  const removable = (item) => item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;
  const affected = body.input.map((item, index) => removable(item) ? index : -1).filter((index) => index >= 0);
  if (!affected.length) return null;
  const pointed = /^input(?:\[(\d+)\]|\.(\d+))(?:\.|\[|$)/.exec(rejection.error.param || '');
  if (pointed && !affected.includes(Number(pointed[1] ?? pointed[2]))) return null;
  const retained = body.input.filter((item) => !removable(item));
  if (!retained.some((item) => item && item.type !== 'reasoning')) return null;
  if (retained.some((item) => item?.type === 'compaction' || hasEncryptedContent(item))) return null;
  return Buffer.from(JSON.stringify({ ...body, input: retained }));
}
