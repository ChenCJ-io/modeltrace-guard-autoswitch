import { execFile } from 'node:child_process';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseToml } from './vendor/smol-toml/parse.js';
import { NETWORK_TTL_MS, resolveOfficialRoute } from './network-route.mjs';

const execute = promisify(execFile);
const coded = (code, message) => Object.assign(new Error(message), { code });
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
// The gateway owns these: an identity-encoded JSON body and observable response.
const RESERVED_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'content-encoding', 'content-type', 'accept-encoding', 'expect', 'authorization']);
// Never forwarded from Codex to a relay: the ChatGPT login, its account and any
// other credential-like header, plus origin/forwarding metadata.
const CLIENT_PRIVATE = new Set(['host', 'connection', 'proxy-authorization', 'proxy-authenticate', 'origin', 'referer', 'referrer',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-uri', 'x-original-url',
  'x-rewrite-url', 'openai-organization', 'openai-project']);
const CLIENT_CREDENTIAL = /authorization|cookie|token|secret|api-?key|account|password|session-key/i;

// Why a CCSwitch card cannot be used as a direct relay. Fixed text only: never
// a URL, header, key or any other value from the card.
export const DIRECT_PROBLEMS = {
  CONFIG_UNREADABLE: 'card_config_unreadable', PROVIDER_MISSING: 'card_provider_missing', PROFILE_UNSUPPORTED: 'card_uses_profile',
  WIRE_API_UNSUPPORTED: 'needs_ccswitch_conversion', BASE_URL_UNSUPPORTED: 'unsupported_base_url',
  KEY_FROM_ENVIRONMENT: 'key_from_environment', HEADERS_FROM_ENVIRONMENT: 'headers_from_environment',
  HEADERS_INVALID: 'card_headers_invalid', KEY_MISSING: 'key_missing',
};

function relayBase(value) {
  const unsupported = () => coded('BASE_URL_UNSUPPORTED', 'Direct relays need an https base_url (http only on loopback) without credentials, query or fragment');
  // Codex reads base_url as a string; an empty `?`/`#` would swallow the endpoint path.
  if (typeof value !== 'string' || !value.trim() || /[?#]/.test(value)) throw unsupported();
  let url;
  try { url = new URL(value); } catch { throw unsupported(); }
  const loopback = LOOPBACK.has(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password) throw unsupported();
  return new URL(`${url.origin}${url.pathname.replace(/\/+$/, '')}`);
}

function stringTable(value, code) {
  if (value == null) return {};
  if (!plainObject(value)) throw coded(code, 'The card has an unsupported header or query table');
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string' || item.length > 8192 || /[\r\n\0]/.test(item) || !name || name.length > 128) throw coded(code, 'The card has an unsupported header or query value');
  }
  return value;
}

/**
 * The request Codex itself would send to the card's provider, rebuilt from the
 * card's saved auth.json and config.toml: base_url, key and static headers.
 * Key order follows Codex: experimental_bearer_token, then env_key (not
 * reproducible here), then auth.json OPENAI_API_KEY. The result holds
 * credentials: keep it in memory for one request; never log or persist it.
 */
export function directConnection(settingsConfig) {
  let saved, doc;
  try { saved = JSON.parse(settingsConfig); } catch { throw coded('CONFIG_UNREADABLE', 'The card configuration is not valid JSON'); }
  const auth = plainObject(saved?.auth) ? saved.auth : {};
  try { doc = typeof saved?.config === 'string' && saved.config.trim() ? parseToml(saved.config) : {}; }
  catch { throw coded('CONFIG_UNREADABLE', 'The card config.toml cannot be parsed'); }
  // A profile can select another provider than the top-level keys; Codex's
  // profile resolution is not reproduced, so never guess the destination.
  if (doc.profile != null || doc.profiles != null) throw coded('PROFILE_UNSUPPORTED', 'The card selects settings through a Codex profile');
  const providerId = typeof doc.model_provider === 'string' && doc.model_provider.trim() ? doc.model_provider.trim() : 'openai';
  let provider, base;
  if (providerId === 'openai') {
    // Codex's built-in OpenAI provider with an API key. Without an explicit
    // openai_base_url its destination can come from the environment, so the
    // card's key is never sent to an implied default address.
    if (typeof doc.openai_base_url !== 'string' || !doc.openai_base_url.trim()) throw coded('PROVIDER_MISSING', 'The card names neither a provider nor an OpenAI base URL');
    provider = {};
    base = doc.openai_base_url;
  } else {
    provider = plainObject(doc.model_providers) && plainObject(doc.model_providers[providerId]) ? doc.model_providers[providerId] : null;
    if (!provider) throw coded('PROVIDER_MISSING', 'The card does not define its selected model provider');
    if (provider.wire_api !== 'responses') throw coded('WIRE_API_UNSUPPORTED', 'The card provider does not use the Responses API');
    base = provider.base_url;
  }
  const baseURL = relayBase(base);
  if (provider.env_http_headers != null && (!plainObject(provider.env_http_headers) || Object.keys(provider.env_http_headers).length)) {
    throw coded('HEADERS_FROM_ENVIRONMENT', 'The card reads headers from environment variables');
  }
  const headers = {};
  for (const [name, value] of Object.entries(stringTable(provider.http_headers, 'HEADERS_INVALID'))) {
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) throw coded('HEADERS_INVALID', 'The card defines a reserved or invalid header');
    headers[name.toLowerCase()] = value;
  }
  const query = Object.entries(stringTable(provider.query_params, 'HEADERS_INVALID'));
  let key = null;
  if (typeof provider.experimental_bearer_token === 'string' && provider.experimental_bearer_token) key = provider.experimental_bearer_token;
  else if (provider.env_key != null) throw coded('KEY_FROM_ENVIRONMENT', 'The card reads its key from an environment variable');
  else if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) key = auth.OPENAI_API_KEY;
  if (key !== null && (key.length > 8192 || /[\r\n\0]/.test(key))) throw coded('KEY_MISSING', 'The card key is not usable');
  // A card may authenticate with its own headers instead of a bearer key.
  if (key === null && !Object.keys(headers).length) throw coded('KEY_MISSING', 'The card has no key for its provider');
  return Object.freeze({ baseURL, key, headers: Object.freeze(headers), query: Object.freeze(query) });
}

// Every Codex card's saved configuration, read once and reduced to the
// connection (or the reason it is unusable) plus the identity fingerprint
// computed by SQLite exactly like inspectCCSwitch. Values stay in memory.
export async function readDirectCards(directory, { id = null } = {}) {
  if (id !== null && (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f]/.test(id))) throw new Error('Invalid CCSwitch card ID');
  const sql = `SELECT id, hex(sha3(json_array(id,app_type,name,settings_config,meta,category),256)) AS fingerprint, settings_config
    FROM providers WHERE app_type='codex'${id === null ? '' : ` AND id='${id.replace(/'/g, "''")}'`}`;
  // Output holds every card's keys: failures get fixed text, never a fragment.
  let rows;
  try {
    const { stdout } = await execute('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', path.join(directory, 'cc-switch.db'), sql],
      { maxBuffer: 16 * 1024 * 1024 });
    rows = JSON.parse(stdout || '[]');
  } catch { throw coded('CCSWITCH_UNREADABLE', 'CCSwitch card configurations could not be read'); }
  const cards = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    let connection = null, problem = null;
    try { connection = directConnection(row.settings_config); }
    catch (error) { problem = DIRECT_PROBLEMS[error.code] || DIRECT_PROBLEMS.CONFIG_UNREADABLE; }
    cards.set(row.id, { fingerprint: row.fingerprint, connection, problem });
  }
  return cards;
}

// The connection for an approved direct route, only while the card is exactly
// the one consented to (same fingerprint as the saved descriptor).
export async function directRouteConnection(directory, route, read = readDirectCards) {
  const card = (await read(directory, { id: route.providerId })).get(route.providerId);
  if (!card || card.fingerprint !== route.providerFingerprint) throw coded('DIRECT_CARD_CHANGED', 'The selected card changed after consent');
  if (!card.connection) throw coded('DIRECT_CARD_UNUSABLE', 'The selected card cannot be used as a direct relay');
  return card.connection;
}

// Codex headers for the relay: drop the ChatGPT login, account and other
// credential-like headers, then add the card's own key and static headers.
export function relayHeaders(clientHeaders, connection) {
  const result = {};
  const omitted = new Set(CLIENT_PRIVATE);
  for (const name of String(clientHeaders.connection || '').split(',')) omitted.add(name.trim().toLowerCase());
  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (value === undefined || omitted.has(lower) || CLIENT_CREDENTIAL.test(lower)) continue;
    result[lower] = value;
  }
  Object.assign(result, connection.headers);
  if (connection.key !== null) result.authorization = `Bearer ${connection.key}`;
  return result;
}

// Responses endpoints, plus model listing for CCSwitch's default card when it
// connects directly (Codex's own query, such as client_version, is kept).
export function relayTarget(connection, endpoint, query = '') {
  if (!['responses', 'responses/compact', 'models'].includes(endpoint)) throw new Error('Unsupported relay endpoint');
  const target = new URL(`${connection.baseURL.href.replace(/\/+$/, '')}/${endpoint}`);
  if (endpoint === 'models' && query) for (const [name, value] of new URLSearchParams(query)) target.searchParams.append(name, value);
  for (const [name, value] of connection.query) target.searchParams.append(name, value);
  return target;
}

/**
 * Direct relay transport. Egress per relay host follows the gateway process's
 * HTTPS_PROXY (with NO_PROXY), then the OS system proxy, then a direct
 * connection; the Official-only network setting does not apply. Redirects are
 * never followed (the gateway refuses them before Codex can).
 */
export function createDirectTransport({ httpsRequestImpl = httpsRequest, httpRequestImpl = httpRequest, env = process.env,
  resolveEgress = host => resolveOfficialRoute({ env, host }), ttlMs = NETWORK_TTL_MS, now = Date.now } = {}) {
  const egress = new Map(), agents = new Map();
  const loopbackAgent = new HttpAgent({ keepAlive: true });
  let closed = false;
  const agentFor = (key, proxyEnv) => {
    if (!agents.has(key)) {
      agents.set(key, new HttpsAgent({ keepAlive: true, proxyEnv, rejectUnauthorized: true }));
      if (agents.size > 16) { const [oldest] = agents.keys(); agents.get(oldest).destroy(); agents.delete(oldest); }
    }
    return agents.get(key);
  };
  return {
    async bind(connection) {
      if (closed) throw coded('DIRECT_TRANSPORT_CLOSED', 'Relay transport is closed');
      const host = connection.baseURL.hostname, loopback = connection.baseURL.protocol === 'http:';
      let route = { mode: 'direct', source: 'loopback', proxy: null, proxyEnv: {} };
      if (!loopback) {
        const cached = egress.get(host);
        if (cached && now() - cached.at < ttlMs) route = cached.route;
        else { route = await resolveEgress(host); egress.set(host, { route, at: now() }); }
      }
      const agent = loopback ? loopbackAgent : agentFor(JSON.stringify([route.source, route.proxy]), route.proxyEnv);
      return {
        // Like Official, one explicit invalid_encrypted_content rejection may be
        // repaired by dropping only the rejected reasoning (state of another route).
        label: 'Relay', retriesEncryptedReasoning: true,
        route: () => route,
        failed: () => { egress.delete(host); },
        request(endpoint, { method = 'POST', headers = {}, query = '' } = {}, callback) {
          if (closed) throw coded('DIRECT_TRANSPORT_CLOSED', 'Relay transport is closed');
          if (method !== (endpoint === 'models' ? 'GET' : 'POST')) throw new Error('Unsupported relay method');
          const target = relayTarget(connection, endpoint, query);
          const options = { method, headers: relayHeaders(headers, connection), agent };
          return loopback ? httpRequestImpl(target, options, callback) : httpsRequestImpl(target, { ...options, rejectUnauthorized: true }, callback);
        },
      };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const agent of agents.values()) agent.destroy();
      loopbackAgent.destroy();
    },
  };
}
