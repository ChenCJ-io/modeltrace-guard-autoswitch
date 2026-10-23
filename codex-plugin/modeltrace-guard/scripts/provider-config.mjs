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

export function resolveProvider(layout, { name, id } = {}, { asPrimary = false } = {}) {
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
  return describeProvider(layout, matches[0].id, asPrimary ? { primaryId: matches[0].id } : {});
}

// Codes let callers explain why a card cannot be selected; messages stay fixed.
const coded = (code, message) => Object.assign(new Error(message), { code });
// The primary uses CCSwitch's ordinary default route. Other third-party cards are
// reached directly with their own saved configuration (direct-route.mjs), except
// cards whose login CCSwitch manages (Copilot/xAI OAuth...): only CCSwitch can
// use those, through an explicit Aggregation (Stack) selector.
export function describeProvider(layout, id, { primaryId = layout.primaryId ?? layout.defaultProvider } = {}) {
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
    const key = layout.stack?.enabled ? Object.entries(layout.stack.keys || {}).find(([, provider]) => provider === id)?.[0] : undefined;
    const member = KEY.test(key || '') && layout.stack.members?.includes(id);
    if (row.id === primaryId) descriptor.key = member ? key : null;
    else if (row.delegatedAuth !== 1) descriptor.transport = 'direct';
    else if (member) descriptor.key = key;
    else throw coded('NOT_IN_STACK', `Add ${JSON.stringify(row.name)} to CCSwitch Aggregation before selecting it; its login is managed by CCSwitch. No provider was switched`);
  }
  validateProvider(descriptor);
  return descriptor;
}

export function validateProvider(p) {
  if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 256 || /[\x00-\x1f]/.test(p.id)
    || typeof p.name !== 'string' || !p.name || p.name.length > 200 || /[\x00-\x1f]/.test(p.name)
    || !/^[a-f0-9]{64}$/i.test(p.fingerprint || '') || !['ccswitch', 'official', 'direct'].includes(p.transport)
    // A ccswitch key selects the Stack member of a CCSwitch-managed login; the
    // primary may carry none (default route) or a saved pre-0.5 one.
    || (p.transport === 'ccswitch' ? p.key !== null && !KEY.test(p.key || '') : p.key !== null)) throw new Error('Invalid saved provider descriptor');
  return p;
}
export const sameProvider = (a, b) => Boolean(a && b && ['id', 'fingerprint', 'transport', 'key'].every(k => a[k] === b[k]));
export function assertProviderCurrent(layout, saved) {
  const current = describeProvider(layout, saved.id);
  // The primary's default route never uses a Stack key, so leaving Aggregation
  // must not invalidate it. A delegated card's key still selects its member.
  const primary = saved.transport === 'ccswitch' && current.transport === 'ccswitch' && saved.id === (layout.primaryId ?? layout.defaultProvider);
  // A pre-0.5 Stack route to a card that is now direct keeps working unchanged
  // (same card, same configuration) until the user switches it.
  const legacyStack = saved.transport === 'ccswitch' && current.transport === 'direct' && typeof saved.key === 'string';
  const comparable = primary ? { ...saved, key: current.key } : legacyStack ? { ...saved, transport: 'direct', key: null } : saved;
  if (!sameProvider(current, comparable)) throw new Error('Selected provider configuration changed; select it again and obtain fresh consent before switching');
}
export function verifyLayout(config, layout) {
  if (layout.mode !== 'proxy' || !layout.attached || layout.pending) throw new Error('CCSwitch must run its local proxy for Codex with no pending config operation');
  if (layout.listener?.listen_address !== '127.0.0.1' || config.upstream !== `http://127.0.0.1:${layout.listener.listen_port}/v1`) throw new Error('CCSwitch listener must match the configured IPv4 loopback endpoint');
  // The backup is only a recommended target. A changed backup card must not
  // block the primary; a later choice re-resolves and re-binds its identity.
  assertProviderCurrent(layout, config.primary);
  return true;
}
// Default forwarding preserves Codex's native protocol headers. Stack selectors
// strip some of those headers inside CCSwitch and can make Codex-only providers
// reject a genuine client. Never repair a drifting default by silently selecting
// another card or falling back to Stack; require the saved primary and no failover.
export function verifyRouteLayout(config, layout, route) {
  if (route == null) route = { transport: config.primary.transport, providerId: config.primary.id,
    providerFingerprint: config.primary.fingerprint, sourceKey: config.primary.key,
    ccswitchMode: config.primary.transport === 'ccswitch' ? 'default' : null, route: 'source' };
  if (route.transport !== 'ccswitch') return true;
  const isPrimary = route.providerId === config.primary.id;
  if (route.ccswitchMode !== (isPrimary ? 'default' : 'stack')) throw new Error('CCSwitch route mode does not match the selected provider');
  if (!isPrimary) return true;
  if (route.route !== 'source' || route.providerFingerprint !== config.primary.fingerprint || (route.sourceKey ?? null) !== (config.primary.key ?? null)) {
    throw new Error('Primary route identity changed; no provider was switched');
  }
  if (layout.defaultProvider !== config.primary.id) throw new Error('CCSwitch default provider changed; restore the configured primary before continuing');
  if (layout.listener?.auto_failover_enabled !== 0) throw new Error('Disable CCSwitch automatic failover before using the primary; switching requires incident consent');
  return true;
}
export async function configureGateway(directory, {
  primaryName, backupName, sourceProvider, fallbackProvider, ccSwitchDirectory = path.join(homedir(), '.cc-switch'), port = 15722,
}, inspect = inspectCCSwitch) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Gateway port must be in 1024..65535');
  const layout = await inspect(ccSwitchDirectory);
  const primary = resolveProvider(layout, { name: primaryName, id: sourceProvider }, { asPrimary: true });
  layout.primaryId = primary.id;
  // The backup is optional: incidents list every CCSwitch card and only mark it as recommended.
  const backup = backupName || fallbackProvider ? resolveProvider(layout, { name: backupName, id: fallbackProvider }) : null;
  if (backup && primary.id === backup.id) throw new Error('Primary and backup must be different configurations');
  const config = { schema: 2, id: randomUUID(), ccSwitchDirectory: path.resolve(ccSwitchDirectory), primary, backup,
    port, upstream: `http://127.0.0.1:${layout.listener?.listen_port}/v1`, token: randomBytes(32).toString('hex') };
  validateGatewayConfig(config); verifyLayout(config, layout); verifyRouteLayout(config, layout);
  await atomicJSON(configPath(directory), config);
  return publicConfig(config);
}
export const publicConfig = ({ token, ...config }) => config;
export function validateGatewayConfig(c) {
  if (c?.schema === 1) throw new Error('v0.2 configuration used automatic switching; reconfigure named primary/backup for per-incident approval');
  if (!c || c.schema !== 2 || !UUID.test(c.id) || !/^[a-f0-9]{64}$/.test(c.token)
    || !path.isAbsolute(c.ccSwitchDirectory || '') || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw new Error('Invalid gateway configuration');
  validateProvider(c.primary);
  if (c.backup != null) {
    validateProvider(c.backup);
    if (c.primary.id === c.backup.id) throw new Error('Primary and backup must differ');
  }
  const url = new URL(c.upstream);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1' || url.search || url.hash || url.username || url.password || Number(url.port) === c.port) throw new Error('Gateway upstream must be the distinct CCSwitch loopback endpoint');
  return c;
}
export async function loadGatewayConfig(directory) { return validateGatewayConfig(await readJSON(configPath(directory))); }
export async function verifyGatewayReady(directory, config, inspect = inspectCCSwitch) {
  const current = await loadGatewayConfig(directory);
  if (current.id !== config.id) throw new Error('Gateway configuration changed; restart the gateway');
  const layout = await inspect(config.ccSwitchDirectory);
  layout.primaryId = config.primary.id;
  verifyLayout(config, layout);
  return layout;
}
export async function verifyGatewayRoute(directory, config, route, inspect = inspectCCSwitch) {
  const layout = await verifyGatewayReady(directory, config, inspect);
  verifyRouteLayout(config, layout, route);
  return layout;
}
export const gatewayURL = (config, initialProvider) => `http://127.0.0.1:${config.port}/${config.token}${initialProvider ? `/provider/${encodeURIComponent(initialProvider)}` : ''}/v1`;
