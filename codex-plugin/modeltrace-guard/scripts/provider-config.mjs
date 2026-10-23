import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
// CCSwitch commits a log row per proxied request. A read-only query that meets
// its brief commit lock must wait instead of failing the request (or voiding an
// approved switch) with `database is locked`.
export const SQLITE_BUSY_TIMEOUT_MS = 3000;
export const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const KEY = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const configPath = directory => path.join(directory, 'gateway-config.json');
// Any native Codex login works for CCSwitch and direct routes: CCSwitch replaces
// the native credential and a direct relay never receives it. Only the Official
// route passes the native login through, so it needs a ChatGPT login.
export const NATIVE_LOGINS = Object.freeze(['chatgpt', 'chatgptAuthTokens', 'apiKey']);
export const officialLogin = type => type === 'chatgpt';
export const runtimePath = directory => path.join(directory, 'gateway-runtime.json');

export async function atomicJSON(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function readJSON(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Credentials remain inside SQLite/CCSwitch. Only identity flags and a hash of
// the saved row leave SQLite; even stored OAuth snapshots are never returned.
export async function inspectCCSwitch(directory = path.join(homedir(), '.cc-switch')) {
  // A codex_oauth type is also used by the unbound Official preset. The type
  // alone cannot distinguish it from a card selecting another managed account.
  // Reject every stored auth field, including future/legacy login snapshots,
  // rather than maintaining a list of token field names. Malformed metadata
  // must not silently become an unbound card through COALESCE defaults.
  const query = `WITH rows AS (
    SELECT id,name,category,
      hex(sha3(json_array(id,app_type,name,settings_config,meta,category),256)) AS fingerprint,
      CASE WHEN json_valid(settings_config) THEN settings_config ELSE '{}' END AS cfg,
      CASE WHEN meta IS NULL THEN '{}' WHEN json_valid(meta) THEN meta ELSE '{}' END AS m,
      CASE WHEN json_valid(settings_config) THEN json_type(settings_config)='object' ELSE 0 END AS configValid,
      CASE WHEN meta IS NULL THEN 1 WHEN json_valid(meta) THEN json_type(meta)='object' ELSE 0 END AS metaValid
    FROM providers WHERE app_type='codex'
  ), flags AS (
    SELECT *, CASE WHEN configValid AND metaValid
      AND json_type(cfg,'$.auth')='object'
      AND NOT EXISTS (SELECT 1 FROM json_each(cfg,'$.auth'))
      AND coalesce(json_type(m,'$.providerType'),'null') IN ('null','text')
      AND coalesce(json_extract(m,'$.providerType'),'') IN ('','codex_oauth')
      AND coalesce(json_type(m,'$.authBinding'),'null') IN ('null','object')
      AND (json_type(m,'$.authBinding.source') IS NULL
        OR (json_type(m,'$.authBinding.source')='text' AND json_extract(m,'$.authBinding.source')='provider_config'))
      AND coalesce(json_type(m,'$.authBinding.authProvider'),'null') IN ('null','text')
      AND coalesce(json_extract(m,'$.authBinding.authProvider'),'') IN ('','codex_oauth')
      AND coalesce(json_type(m,'$.authBinding.accountId'),'null') IN ('null','text')
      AND length(trim(coalesce(json_extract(m,'$.authBinding.accountId'),'')))=0
      AND coalesce(json_type(m,'$.githubAccountId'),'null') IN ('null','text')
      AND length(trim(coalesce(json_extract(m,'$.githubAccountId'),'')))=0
      THEN 1 ELSE 0 END AS followsNativeLogin
    FROM rows
  ) SELECT id,name,category,fingerprint,
    CASE WHEN category='official' AND followsNativeLogin
      AND length(trim(coalesce(json_extract(cfg,'$.config'),'')))=0
      AND length(trim(coalesce(json_extract(cfg,'$.base_url'),'')))=0
      AND length(trim(coalesce(json_extract(cfg,'$.baseUrl'),'')))=0
      AND length(trim(coalesce(json_extract(cfg,'$.baseURL'),'')))=0
      THEN 1 ELSE 0 END AS nativeOfficial,
    followsNativeLogin,
    CASE WHEN json_extract(m,'$.authBinding.source')='managed_account'
      AND (json_extract(m,'$.authBinding.authProvider')='codex_oauth'
        OR json_extract(m,'$.providerType')='codex_oauth')
      THEN 1 ELSE 0 END AS managedCodexAccount,
    CASE WHEN (json_type(m,'$.providerType')='text' AND json_extract(m,'$.providerType') NOT IN ('','codex_oauth'))
      OR json_extract(m,'$.authBinding.source')='managed_account'
      THEN 1 ELSE 0 END AS delegatedAuth
    FROM flags`;
  const [providers, listeners, live] = await Promise.all([
    ...[query, "SELECT listen_address,listen_port,auto_failover_enabled FROM proxy_config WHERE app_type='codex'"].map(async sql =>
      JSON.parse((await execute('sqlite3', ['-readonly', '-json', '-cmd', `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`,
        path.join(directory, 'cc-switch.db'), sql], { maxBuffer: 1024 * 1024 })).stdout || '[]')),
    readJSON(path.join(directory, 'live-state.json')),
  ]);
  const mode = live?.apps?.codex || {};
  return { directory: path.resolve(directory), providers, listener: listeners[0] || null,
    mode: mode.mode || 'direct', attached: mode.attached === true, defaultProvider: mode.proxy_route || null,
    pending: Boolean(mode.pending), stack: mode.stack || { enabled: false, members: [], keys: {} } };
}

export function resolveProvider(layout, { name, id } = {}) {
  if (Boolean(name) === Boolean(id)) throw new Error('Specify exactly one provider name or provider ID');
  if ((name && (typeof name !== 'string' || !name.trim())) || (id && typeof id !== 'string')) throw new Error('Provider name or ID must be a nonempty string');
  const selected = id ? layout.providers.filter(p => p.id === id) : layout.providers.filter(p => p.name === name.trim());
  const matches = selected.length || id ? selected : layout.providers.filter(p => typeof p.name === 'string' && p.name.toLowerCase() === name.trim().toLowerCase());
  if (matches.length !== 1) {
    const error = new Error(matches.length ? `CCSwitch has multiple configurations named ${JSON.stringify(name)}; choose the exact provider ID` : `CCSwitch configuration not found: ${JSON.stringify(name || id)}`);
    error.code = matches.length ? 'AMBIGUOUS_PROVIDER' : 'PROVIDER_NOT_FOUND';
    error.candidates = matches.map(({ id, name }) => ({ id, name }));
    throw error;
  }
  return describeProvider(layout, matches[0].id);
}

// Codes let callers explain why a card cannot be selected; messages stay fixed.
const coded = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
// What kind of card this is. A key-based card is reached directly with its own
// saved configuration (direct-route.mjs); a card whose login CCSwitch manages
// (Copilot/xAI OAuth...) is only usable through CCSwitch (key: its Aggregation
// selector, if any); Official is the current native login. Which route a
// conversation takes for the card is routeDescriptor's choice.
export function describeProvider(layout, id) {
  const row = layout.providers.find(p => p.id === id);
  if (!row || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || /[\x00-\x1f]/.test(row.name)) throw coded('INVALID_PROVIDER', 'Invalid or missing CCSwitch provider identity');
  // Older managed Official cards can lack category. They still select a Codex
  // account, and cannot be substituted by native login or a stale Stack entry.
  if (row.managedCodexAccount === 1) throw coded('MANAGED_ACCOUNT', 'This Official card selects a managed Codex account; native passthrough must not substitute the current CLI account');
  const descriptor = { id: row.id, name: row.name, fingerprint: row.fingerprint, transport: 'ccswitch', key: null };
  if (row.nativeOfficial === 1) {
    if (row.followsNativeLogin !== 1) throw coded('OFFICIAL_NOT_NATIVE', 'This Official card binds another account or stores a login snapshot; native passthrough must not substitute the current CLI account');
    descriptor.transport = 'official';
  } else {
    // An Official card that binds an account or stores settings must not be
    // substituted by the native login or by a direct connection.
    if (row.category === 'official') throw coded('OFFICIAL_NOT_NATIVE', 'This Official card is not an unbound native login with empty auth and connection settings; its selected account must not be substituted');
    if (row.delegatedAuth !== 1) descriptor.transport = 'direct';
    else {
      const key = layout.stack?.enabled ? Object.entries(layout.stack.keys || {}).find(([, provider]) => provider === id)?.[0] : undefined;
      if (KEY.test(key || '') && layout.stack.members?.includes(id)) descriptor.key = key;
    }
  }
  validateProvider(descriptor);
  return descriptor;
}

/**
 * The route a conversation takes for one card: Official; direct when the card's
 * saved configuration can be reached directly (`card` is its direct-route.mjs
 * reading); otherwise through CCSwitch, by its default route (key null) while
 * the card is CCSwitch's default card, or by the card's Aggregation selector.
 * Throws with a reason when none applies.
 */
export function routeDescriptor(layout, id, card) {
  const descriptor = describeProvider(layout, id);
  if (descriptor.transport === 'official') return descriptor;
  const isDefault = layout.defaultProvider === id;
  if (descriptor.transport === 'direct') {
    if (card && !card.problem && card.fingerprint === descriptor.fingerprint) return descriptor;
    if (isDefault) return { ...descriptor, transport: 'ccswitch', key: null };
    throw coded('DIRECT_UNUSABLE', 'This card cannot be reached directly and is not CCSwitch\'s default card; no provider was switched',
      { problem: card ? card.problem || 'card_changed' : 'card_config_unreadable' });
  }
  if (isDefault) return { ...descriptor, key: null };
  if (descriptor.key) return descriptor;
  throw coded('NOT_IN_STACK', `Add ${JSON.stringify(descriptor.name)} to CCSwitch Aggregation before selecting it; its login is managed by CCSwitch. No provider was switched`);
}

// CCSwitch's current default Codex card: where a new conversation starts. It is
// defined while CCSwitch runs its local proxy (Routing or Aggregation mode); in
// its Direct mode CCSwitch rewrites Codex's own configuration on every card
// change, which would bypass this gateway altogether.
export function defaultCardId(layout) {
  if (layout.mode !== 'proxy' || !layout.attached || layout.pending) {
    throw coded('CCSWITCH_NOT_PROXIED', 'CCSwitch must run its local proxy for Codex (Routing or Aggregation mode) so that its default card is defined');
  }
  if (!layout.defaultProvider || !layout.providers.some(p => p.id === layout.defaultProvider)) throw coded('NO_DEFAULT_CARD', 'CCSwitch has no default Codex card; select one in CC Switch');
  return layout.defaultProvider;
}

// A CCSwitch route without a selector is CCSwitch's default route; with one,
// the card's Aggregation selector.
export const ccswitchMode = provider => (provider.transport === 'ccswitch' ? (provider.key ? 'stack' : 'default') : null);

export function validateProvider(p) {
  if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 256 || /[\x00-\x1f]/.test(p.id)
    || typeof p.name !== 'string' || !p.name || p.name.length > 200 || /[\x00-\x1f]/.test(p.name)
    || !/^[a-f0-9]{64}$/i.test(p.fingerprint || '') || !['ccswitch', 'official', 'direct'].includes(p.transport)
    // A ccswitch key is an Aggregation selector; null means CCSwitch's default route.
    || (p.transport === 'ccswitch' ? p.key !== null && !KEY.test(p.key || '') : p.key !== null)) throw new Error('Invalid saved provider descriptor');
  return p;
}
export const sameProvider = (a, b) => Boolean(a && b && ['id', 'fingerprint', 'transport', 'key'].every(k => a[k] === b[k]));
// A saved route still names the same, unchanged card, of a kind that can take
// that route. Whether the route is usable right now is verifyRouteLayout's job
// (CCSwitch default card, Aggregation) and, for a direct relay, the per-request
// card read (directRouteConnection).
export function assertProviderCurrent(layout, saved) {
  const current = describeProvider(layout, saved.id);
  const compatible = current.fingerprint === saved.fingerprint && current.name === saved.name && (
    saved.transport === 'official' ? current.transport === 'official'
      : saved.transport === 'direct' ? current.transport === 'direct'
        : saved.key === null ? current.transport !== 'official'
          : current.transport === 'ccswitch' && current.key === saved.key);
  if (!compatible) throw new Error('Selected provider configuration changed; select it again and obtain fresh consent before switching');
}
function verifyCCSwitchProxy(config, layout) {
  if (layout.mode !== 'proxy' || !layout.attached || layout.pending) throw coded('CCSWITCH_NOT_PROXIED', 'CCSwitch must run its local proxy for Codex with no pending config operation');
  if (!config.upstream || layout.listener?.listen_address !== '127.0.0.1' || config.upstream !== `http://127.0.0.1:${layout.listener.listen_port}/v1`) {
    throw coded('CCSWITCH_LISTENER_CHANGED', 'CCSwitch listener must match the configured IPv4 loopback endpoint');
  }
}
// Only CCSwitch routes depend on CCSwitch's state. Its default route is valid
// while the card is still CCSwitch's default card and automatic failover is off
// (failover would move the conversation silently); never repair drift by
// selecting another card. An Aggregation route needs its member selector.
export function verifyRouteLayout(config, layout, route) {
  if (route == null || route.transport !== 'ccswitch') return true;
  verifyCCSwitchProxy(config, layout);
  if (route.ccswitchMode === 'default' && route.sourceKey == null) {
    if (layout.defaultProvider !== route.providerId) {
      throw coded('CCSWITCH_DEFAULT_CHANGED', 'CCSwitch\'s default card changed, and this card is only usable as CCSwitch\'s default card; switch this conversation or start a new one');
    }
    if (layout.listener?.auto_failover_enabled !== 0) throw coded('CCSWITCH_FAILOVER', 'Disable CCSwitch automatic failover while a conversation uses CCSwitch\'s default route; failover would move it silently');
    return true;
  }
  if (route.ccswitchMode !== 'stack' || !route.sourceKey) throw new Error('CCSwitch route mode does not match the selected provider');
  if (!layout.stack?.enabled || !layout.stack.members?.includes(route.providerId) || layout.stack.keys?.[route.sourceKey] !== route.providerId) {
    throw coded('NOT_IN_STACK', 'This card is no longer a CCSwitch Aggregation member');
  }
  return true;
}
/**
 * Gateway configuration (schema 3). New conversations start on CCSwitch's
 * default card, so there is no primary to choose; `backup` is an optional
 * recommended switch target. Reconfiguring keeps the capability token, so
 * Codex's entry URL stays valid. Changing only the recommended backup also
 * keeps the configuration ID (routes, conversations and a running gateway stay
 * valid); any other change starts a new configuration ID, so threads routed
 * under the earlier one need a new conversation. `requireSameId` refuses such
 * a change before anything is written (used while the gateway runs).
 */
export async function configureGateway(directory, {
  backupName, fallbackProvider, ccSwitchDirectory, port, requireSameId = false,
} = {}, inspect = inspectCCSwitch, readCards = null) {
  const previous = await readJSON(configPath(directory)).catch(() => null);
  let reusable = null;
  try { reusable = previous ? validateGatewayConfig(previous) : null; } catch {}
  port ??= Number.isInteger(previous?.port) ? previous.port : 15722;
  ccSwitchDirectory ??= path.isAbsolute(previous?.ccSwitchDirectory || '') ? previous.ccSwitchDirectory : path.join(homedir(), '.cc-switch');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Gateway port must be in 1024..65535');
  const changesSetup = () => !reusable || reusable.ccSwitchDirectory !== path.resolve(ccSwitchDirectory) || reusable.port !== port;
  const needsStop = () => new Error('Stop this gateway before reconfiguring it: this change needs a new configuration ID');
  if (requireSameId && changesSetup()) throw needsStop();
  const layout = await inspect(ccSwitchDirectory);
  let backup = null;
  if (backupName || fallbackProvider) {
    const identity = resolveProvider(layout, { name: backupName, id: fallbackProvider });
    readCards ||= (await import('./direct-route.mjs')).readDirectCards;
    backup = routeDescriptor(layout, identity.id, (await readCards(ccSwitchDirectory, { id: identity.id })).get(identity.id));
    // Recommending CCSwitch's default card would just restart where new conversations begin.
    if (backup.transport === 'ccswitch' && backup.key === null) throw new Error('Recommend a card that can be reached directly, OpenAI Official or a CCSwitch Aggregation member as the backup');
  }
  const listener = layout.listener?.listen_address === '127.0.0.1' && Number.isInteger(layout.listener.listen_port) ? layout.listener.listen_port : null;
  const upstream = listener ? `http://127.0.0.1:${listener}/v1` : null;
  const kept = !changesSetup() && reusable.upstream === upstream;
  if (requireSameId && !kept) throw needsStop();
  const token = /^[a-f0-9]{64}$/.test(previous?.token || '') ? previous.token : randomBytes(32).toString('hex');
  const config = { schema: 3, id: kept ? reusable.id : randomUUID(), ccSwitchDirectory: path.resolve(ccSwitchDirectory), backup, port, upstream, token };
  validateGatewayConfig(config);
  await atomicJSON(configPath(directory), config);
  return { ...publicConfig(config), configurationKept: kept };
}
export const publicConfig = ({ token, ...config }) => config;
export function validateGatewayConfig(c) {
  if (c?.schema === 1 || c?.schema === 2) {
    throw coded('CONFIG_OUTDATED', 'The gateway configuration predates 0.5 (a fixed primary route). Connect again to update it; new conversations then start on CCSwitch\'s default card');
  }
  if (!c || c.schema !== 3 || !UUID.test(c.id) || !/^[a-f0-9]{64}$/.test(c.token)
    || !path.isAbsolute(c.ccSwitchDirectory || '') || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw new Error('Invalid gateway configuration');
  if (c.backup != null) validateProvider(c.backup);
  if (c.upstream === null) return c;
  const url = new URL(c.upstream);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1' || url.search || url.hash || url.username || url.password || Number(url.port) === c.port) throw new Error('Gateway upstream must be the distinct CCSwitch loopback endpoint');
  return c;
}
export async function loadGatewayConfig(directory) {
  const config = await readJSON(configPath(directory));
  if (config === null) throw coded('NOT_CONFIGURED', 'ModelTrace is not set up yet; connect it first');
  return validateGatewayConfig(config);
}
export async function verifyGatewayReady(directory, config, inspect = inspectCCSwitch) {
  const current = await loadGatewayConfig(directory);
  if (current.id !== config.id) throw new Error('Gateway configuration changed; restart the gateway');
  return inspect(config.ccSwitchDirectory);
}
export async function verifyGatewayRoute(directory, config, route, inspect = inspectCCSwitch) {
  const layout = await verifyGatewayReady(directory, config, inspect);
  verifyRouteLayout(config, layout, route);
  return layout;
}
export const gatewayURL = (config, initialProvider) => `http://127.0.0.1:${config.port}/${config.token}${initialProvider ? `/provider/${encodeURIComponent(initialProvider)}` : ''}/v1`;
