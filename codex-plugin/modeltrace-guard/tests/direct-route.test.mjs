import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createDirectTransport, directConnection, directRouteConnection, readDirectCards, relayHeaders, relayTarget } from '../scripts/direct-route.mjs';
import { atomicJSON, inspectCCSwitch } from '../scripts/provider-config.mjs';

const execute = promisify(execFile);
const KEY = 'sk-synthetic-direct-key', BEARER = 'synthetic-bearer-token', ACTOR = 'synthetic-actor-header-value';
const card = (config, auth = { OPENAI_API_KEY: KEY }) => JSON.stringify({ auth, config });
// Shaped like the cards CCSwitch stores: a whole config.toml, unrelated tables included.
const relayToml = (provider = '', extra = '', { wire = 'responses', base = 'https://relay.example.invalid/v1/' } = {}) => `model_provider = "relay"
model = "gpt-6.1-sol"
developer_instructions = """
Never read [model_providers.decoy] or base_url = "https://decoy.invalid" as configuration.
"""

[model_providers.decoy]
base_url = "https://decoy.invalid/v1"
wire_api = "responses"

[model_providers.relay]
name = "relay"
base_url = "${base}"
wire_api = "${wire}"
${provider}

[mcp_servers.search]
command = "npx"
args = ["-y", "search-mcp"]
[mcp_servers.search.env]
SEARCH_API_KEY = "synthetic-unrelated-secret"
${extra}`;

test('a relay card is rebuilt exactly like Codex would call it, from its own provider table only', () => {
  const api2 = directConnection(card(relayToml(`experimental_bearer_token = "${BEARER}"
requires_openai_auth = false
[model_providers.relay.http_headers]
x-openai-actor-authorization = "${ACTOR}"`)));
  assert.equal(api2.baseURL.href, 'https://relay.example.invalid/v1');
  assert.equal(api2.key, BEARER, 'experimental_bearer_token comes before auth.json');
  assert.deepEqual(api2.headers, { 'x-openai-actor-authorization': ACTOR });
  assert.deepEqual(api2.query, []);
  const doro = directConnection(card(relayToml('requires_openai_auth = true')));
  assert.equal(doro.key, KEY);
  const builtIn = directConnection(card('openai_base_url = "https://api.openai.com/v1"'));
  assert.equal(builtIn.baseURL.href, 'https://api.openai.com/v1'); assert.equal(builtIn.key, KEY);
  const queried = directConnection(card(relayToml('query_params = { "api-version" = "2026-01-01" }')));
  assert.deepEqual(queried.query, [['api-version', '2026-01-01']]);
  const keyless = directConnection(card(relayToml('http_headers = { "api-key" = "synthetic-header-auth" }'), {}));
  assert.equal(keyless.key, null, 'a card may authenticate with its own headers');
  assert.ok(Object.isFrozen(api2) && Object.isFrozen(api2.headers));
});

test('cards the gateway cannot reproduce are refused with a reason, never a value', () => {
  const cases = [
    ['{not json', 'CONFIG_UNREADABLE'],
    [card('model_provider = "relay"\n[model_providers.relay\n'), 'CONFIG_UNREADABLE'],
    [card('model_provider = "missing"'), 'PROVIDER_MISSING'],
    // Never an implied destination: no provider and no explicit OpenAI base URL.
    [card('model = "gpt-6.1-sol"'), 'PROVIDER_MISSING'],
    [card('openai_base_url = ""'), 'PROVIDER_MISSING'],
    [card('openai_base_url = ["https://relay.example.invalid/v1"]'), 'PROVIDER_MISSING'],
    [card(`profile = "p"\n${relayToml().replace('model_provider = "relay"', '')}\n[profiles.p]\nmodel_provider = "relay"`), 'PROFILE_UNSUPPORTED'],
    [card(relayToml().replace('base_url = "https://relay.example.invalid/v1/"', 'base_url = ["https://relay.example.invalid/v1"]')), 'BASE_URL_UNSUPPORTED'],
    [card(relayToml('', '', { base: 'https://relay.example.invalid/v1?' })), 'BASE_URL_UNSUPPORTED'],
    [card(relayToml('', '', { base: 'https://relay.example.invalid/v1#' })), 'BASE_URL_UNSUPPORTED'],
    [card(relayToml('http_headers = { "Accept-Encoding" = "gzip" }')), 'HEADERS_INVALID'],
    [card(relayToml('http_headers = { "expect" = "100-continue" }')), 'HEADERS_INVALID'],
    [card(relayToml('http_headers = { "content-type" = "text/plain" }')), 'HEADERS_INVALID'],
    [card(relayToml('', '', { wire: 'chat' })), 'WIRE_API_UNSUPPORTED'],
    [card(relayToml('', '', { base: 'http://relay.example.invalid/v1' })), 'BASE_URL_UNSUPPORTED'],
    [card(relayToml('', '', { base: `https://user:${KEY}@relay.example.invalid/v1` })), 'BASE_URL_UNSUPPORTED'],
    [card(relayToml('', '', { base: `https://relay.example.invalid/v1?key=${KEY}` })), 'BASE_URL_UNSUPPORTED'],
    [card(relayToml('env_key = "RELAY_KEY"')), 'KEY_FROM_ENVIRONMENT'],
    [card(relayToml('env_http_headers = { "x-team" = "TEAM_ID" }')), 'HEADERS_FROM_ENVIRONMENT'],
    [card(relayToml('http_headers = { "Authorization" = "Bearer elsewhere" }')), 'HEADERS_INVALID'],
    [card(relayToml('http_headers = { "host" = "elsewhere.invalid" }')), 'HEADERS_INVALID'],
    [card(relayToml(`http_headers = { "x-split" = "a\\r\\nx-injected: ${KEY}" }`)), 'HEADERS_INVALID'],
    [card(relayToml(), {}), 'KEY_MISSING'],
    [card(relayToml(), { tokens: { access_token: 'synthetic-chatgpt-token' } }), 'KEY_MISSING'],
  ];
  for (const [settings, code] of cases) {
    assert.throws(() => directConnection(settings), error => {
      assert.equal(error.code, code, settings.slice(0, 60));
      for (const secret of [KEY, BEARER, ACTOR, 'relay.example.invalid', 'synthetic-chatgpt-token', 'elsewhere']) assert.ok(!error.message.includes(secret));
      return true;
    });
  }
  // A loopback relay may use http (a local proxy on this computer).
  assert.equal(directConnection(card(relayToml('', '', { base: 'http://127.0.0.1:8080/v1' }))).baseURL.port, '8080');
});

test('the relay receives the card key and headers, never the ChatGPT login, account or other credentials', () => {
  const connection = directConnection(card(relayToml(`experimental_bearer_token = "${BEARER}"
http_headers = { "x-openai-actor-authorization" = "${ACTOR}", "originator" = "card-originator" }`)));
  const headers = relayHeaders({
    authorization: 'Bearer synthetic-chatgpt-access-token', 'chatgpt-account-id': 'synthetic-account', cookie: 'session=synthetic',
    'x-api-key': 'synthetic-other', 'proxy-authorization': 'Basic synthetic', 'openai-organization': 'org-synthetic', 'x-session-token': 'synthetic',
    connection: 'x-hop', 'x-hop': 'synthetic', origin: 'https://evil.invalid', referer: 'https://evil.invalid',
    originator: 'codex_cli_rs', 'user-agent': 'codex_cli_rs/0.163.0', version: '0.163.0', session_id: 'synthetic-session',
    'thread-id': 'synthetic-thread', 'x-codex-beta-features': 'synthetic', 'openai-beta': 'responses=experimental',
    'content-type': 'application/json', accept: 'text/event-stream',
  }, connection);
  assert.deepEqual(headers, {
    authorization: `Bearer ${BEARER}`, 'x-openai-actor-authorization': ACTOR, originator: 'card-originator',
    'user-agent': 'codex_cli_rs/0.163.0', version: '0.163.0', session_id: 'synthetic-session', 'thread-id': 'synthetic-thread',
    'x-codex-beta-features': 'synthetic', 'openai-beta': 'responses=experimental', 'content-type': 'application/json', accept: 'text/event-stream',
  });
  const keyless = relayHeaders({ authorization: 'Bearer synthetic-chatgpt-access-token' }, { ...connection, key: null });
  assert.equal(keyless.authorization, undefined, 'a keyless card never inherits the ChatGPT login');
});

test('relay targets keep the card path and query and accept only Responses endpoints', () => {
  const connection = directConnection(card(relayToml('query_params = { "api-version" = "v" }')));
  assert.equal(relayTarget(connection, 'responses').href, 'https://relay.example.invalid/v1/responses?api-version=v');
  assert.equal(relayTarget(connection, 'responses/compact').href, 'https://relay.example.invalid/v1/responses/compact?api-version=v');
  for (const endpoint of ['models', '../responses', 'responses?x=1']) assert.throws(() => relayTarget(connection, endpoint));
  const bare = directConnection(card(relayToml('', '', { base: 'https://relay.example.invalid' })));
  assert.equal(relayTarget(bare, 'responses').href, 'https://relay.example.invalid/responses', 'like Codex: base_url + /responses');
});

test('cards are read with the same fingerprint as inspection, and a changed card is refused after consent', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'direct-route-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = path.join(directory, 'cc-switch.db');
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  await execute('sqlite3', [db, `CREATE TABLE providers(id TEXT,name TEXT,category TEXT,app_type TEXT,settings_config TEXT,meta TEXT);
    CREATE TABLE proxy_config(app_type TEXT,listen_address TEXT,listen_port INTEGER,auto_failover_enabled INTEGER);
    INSERT INTO providers VALUES('relay','Relay',NULL,'codex',${quote(card(relayToml(`experimental_bearer_token = "${BEARER}"`)))},'{}');
    INSERT INTO providers VALUES('it''s','Quoted',NULL,'codex',${quote(card(relayToml('', '', { wire: 'chat' })))},'{}');
    INSERT INTO providers VALUES('claude','Claude',NULL,'claude','{}','{}');`]);
  await atomicJSON(path.join(directory, 'live-state.json'), { apps: { codex: { mode: 'proxy', attached: true, proxy_route: 'relay' } } });
  const cards = await readDirectCards(directory);
  assert.deepEqual([...cards.keys()].sort(), ["it's", 'relay']);
  const inspected = await inspectCCSwitch(directory);
  assert.equal(cards.get('relay').fingerprint, inspected.providers.find(row => row.id === 'relay').fingerprint);
  assert.equal(cards.get('relay').problem, null); assert.equal(cards.get('relay').connection.key, BEARER);
  assert.equal(cards.get("it's").problem, 'needs_ccswitch_conversion');
  assert.deepEqual([...(await readDirectCards(directory, { id: "it's" })).keys()], ["it's"]);
  const route = { providerId: 'relay', providerFingerprint: cards.get('relay').fingerprint };
  assert.equal((await directRouteConnection(directory, route)).key, BEARER);
  await execute('sqlite3', [db, `UPDATE providers SET settings_config=${quote(card(relayToml(`experimental_bearer_token = "rotated"`)))} WHERE id='relay'`]);
  await assert.rejects(directRouteConnection(directory, route), { code: 'DIRECT_CARD_CHANGED' });
  await assert.rejects(directRouteConnection(directory, { providerId: "it's", providerFingerprint: cards.get("it's").fingerprint }), { code: 'DIRECT_CARD_UNUSABLE' });
  await assert.rejects(readDirectCards(directory, { id: 'bad\nid' }));
});

test('relay transport verifies TLS, resolves egress per host and re-resolves after a failure', async () => {
  const calls = [], resolved = [];
  const transport = createDirectTransport({
    resolveEgress: async host => { resolved.push(host); return { mode: 'auto', source: 'system', proxy: 'http://127.0.0.1:7897', proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:7897' } }; },
    httpsRequestImpl: (target, options) => { calls.push({ kind: 'https', url: target.href, options }); return { fake: true }; },
    httpRequestImpl: (target, options) => { calls.push({ kind: 'http', url: target.href, options }); return { fake: true }; },
  });
  try {
    const remote = await transport.bind(directConnection(card(relayToml(`experimental_bearer_token = "${BEARER}"`))));
    remote.request('responses', { method: 'POST', headers: { authorization: 'Bearer synthetic-chatgpt' } });
    assert.equal(calls[0].kind, 'https'); assert.equal(calls[0].url, 'https://relay.example.invalid/v1/responses');
    assert.equal(calls[0].options.rejectUnauthorized, true); assert.equal(calls[0].options.headers.authorization, `Bearer ${BEARER}`);
    assert.equal(remote.route().source, 'system'); assert.equal(remote.label, 'Relay'); assert.equal(remote.retriesEncryptedReasoning, true);
    assert.throws(() => remote.request('responses', { method: 'GET' }));
    await transport.bind(directConnection(card(relayToml())));
    assert.deepEqual(resolved, ['relay.example.invalid'], 'egress is cached per host');
    remote.failed();
    await transport.bind(directConnection(card(relayToml())));
    assert.deepEqual(resolved, ['relay.example.invalid', 'relay.example.invalid'], 'a failure re-resolves egress');
    const local = await transport.bind(directConnection(card(relayToml('', '', { base: 'http://127.0.0.1:8080/v1' }))));
    local.request('responses', { method: 'POST', headers: {} });
    assert.equal(calls.at(-1).kind, 'http'); assert.equal(local.route().source, 'loopback'); assert.equal(resolved.length, 2);
  } finally { transport.close(); }
  await assert.rejects(transport.bind(directConnection(card(relayToml()))), { code: 'DIRECT_TRANSPORT_CLOSED' });
});
