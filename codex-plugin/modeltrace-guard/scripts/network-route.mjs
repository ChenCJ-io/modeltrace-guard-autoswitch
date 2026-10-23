import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { OFFICIAL_HOST, redactProxyURL } from './official-transport.mjs';
import { atomicJSON, gatewayURL, loadGatewayConfig, readJSON } from './provider-config.mjs';

// Egress for the fixed Official HTTPS destination only. A proxy carries the TLS
// tunnel to chatgpt.com; it is not route identity, so changing it never creates
// a configuration ID, migrates a thread route or affects incident consent.
// Node does not read OS proxy settings by itself, while native Codex does. The
// gateway may be spawned by a hook or tool call whose environment has no proxy,
// so `auto` falls back to the OS system proxy the native client would use.
const run = promisify(execFile);
export const networkPath = directory => path.join(directory, 'network.json');
export const NETWORK_TTL_MS = 15000;
const MODES = ['auto', 'direct'];
const WARNINGS = new Set(['pac_unsupported', 'socks_unsupported', 'system_proxy_unreadable', 'system_proxy_invalid']);

const invalidProxy = () => Object.assign(new Error('Official proxy must be auto, direct, or an http(s)://host:port URL; SOCKS and PAC are not supported by the Node gateway'),
  { code: 'INVALID_OFFICIAL_PROXY' });

export function parseProxySetting(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (MODES.includes(text.toLowerCase())) return text.toLowerCase();
  let url;
  try { url = new URL(text); } catch { throw invalidProxy(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.search || url.hash) throw invalidProxy();
  return url.href.replace(/\/$/, '');
}

export const redactProxy = value => value == null || MODES.includes(value) ? value ?? null : redactProxyURL(value);

export async function readNetworkSetting(directory) {
  const saved = await readJSON(networkPath(directory));
  if (!saved) return { officialProxy: 'auto', saved: false };
  try { return { officialProxy: parseProxySetting(saved.officialProxy), saved: true, updatedAt: saved.updatedAt ?? null }; }
  catch { throw Object.assign(new Error(`Invalid ${networkPath(directory)}; save it again with network --official-proxy`), { code: 'INVALID_OFFICIAL_PROXY' }); }
}

export async function writeNetworkSetting(directory, value, now = Date.now()) {
  const officialProxy = parseProxySetting(value);
  // atomicJSON writes 0600: an explicit proxy URL may carry credentials.
  await atomicJSON(networkPath(directory), { schema: 1, officialProxy, updatedAt: now });
  return { officialProxy: redactProxy(officialProxy), saved: true, updatedAt: now };
}

// Host patterns from macOS ExceptionsList, Windows ProxyOverride or NO_PROXY.
// Only name patterns can match the fixed host; CIDR and <local> entries cannot.
export function bypassesProxy(host, patterns) {
  return patterns.some((raw) => {
    const pattern = String(raw).trim().toLowerCase();
    if (!pattern || pattern === '<local>' || pattern.includes('/')) return false;
    if (pattern === '*') return true;
    const suffix = pattern.startsWith('*.') ? pattern.slice(1) : pattern.startsWith('.') ? pattern : null;
    if (suffix) return host.endsWith(suffix);
    if (pattern.includes('*')) return new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(host);
    return host === pattern;
  });
}

const hostPort = (host, port) => `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;

export function parseMacProxy(text, host = OFFICIAL_HOST) {
  const values = {}, exceptions = [];
  let inExceptions = false;
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9]+) : (.*)$/.exec(line);
    if (!match) continue;
    if (/^\d+$/.test(match[1])) { if (inExceptions) exceptions.push(match[2].trim()); continue; }
    inExceptions = match[1] === 'ExceptionsList' && match[2].startsWith('<array>');
    if (!inExceptions) values[match[1]] = match[2].trim();
  }
  // Like native clients, an https:// destination uses only the HTTPS proxy entry.
  if (values.HTTPSEnable === '1' && values.HTTPSProxy && /^\d{1,5}$/.test(values.HTTPSPort || '')) {
    if (bypassesProxy(host, exceptions)) return { proxy: null, bypassed: true };
    return { proxy: hostPort(values.HTTPSProxy, values.HTTPSPort) };
  }
  if (values.ProxyAutoConfigEnable === '1') return { proxy: null, warning: 'pac_unsupported' };
  if (values.SOCKSEnable === '1') return { proxy: null, warning: 'socks_unsupported' };
  return { proxy: null };
}

export function parseWindowsProxy(text, host = OFFICIAL_HOST) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  if (/^0x0*1$/i.test(values.ProxyEnable || '') && values.ProxyServer) {
    let entry = values.ProxyServer;
    // "host:port" applies to every protocol; "http=..;https=..;socks=.." is per protocol.
    if (entry.includes('=')) {
      const map = Object.fromEntries(entry.split(';').map(part => part.split('=').map(item => item.trim()))
        .filter(([key, value]) => key && value).map(([key, value]) => [key.toLowerCase(), value]));
      entry = map.https || null;
      if (!entry) return { proxy: null, ...(map.socks ? { warning: 'socks_unsupported' } : {}) };
    }
    if (bypassesProxy(host, (values.ProxyOverride || '').split(';'))) return { proxy: null, bypassed: true };
    if (/^socks/i.test(entry)) return { proxy: null, warning: 'socks_unsupported' };
    return { proxy: /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `http://${entry}` };
  }
  if (values.AutoConfigURL) return { proxy: null, warning: 'pac_unsupported' };
  return { proxy: null };
}

const readCommand = async (file, args) => (await run(file, args, { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 })).stdout;

// Linux has no system proxy API that native Codex reads; it uses environment
// variables only, so this returns no proxy there.
export async function systemProxy({ platform = process.platform, exec = readCommand, host = OFFICIAL_HOST } = {}) {
  let found;
  try {
    if (platform === 'darwin') found = parseMacProxy(await exec('scutil', ['--proxy']), host);
    else if (platform === 'win32') found = parseWindowsProxy(await exec('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']), host);
    else return { proxy: null };
  } catch { return { proxy: null, warning: 'system_proxy_unreadable' }; }
  if (!found.proxy) return found;
  try { return { proxy: parseProxySetting(found.proxy) }; } catch { return { proxy: null, warning: 'system_proxy_invalid' }; }
}

const route = (mode, source, proxy, extra = {}) => ({ mode, source, proxy, proxyEnv: proxy ? { HTTPS_PROXY: proxy } : {}, ...extra });

/**
 * Order: explicit setting (network --official-proxy) > the gateway process's
 * HTTPS_PROXY/https_proxy (Node then also applies its NO_PROXY) > OS system
 * HTTPS proxy (macOS scutil, Windows Internet Settings) > direct connection.
 */
export async function resolveOfficialRoute({ directory, env = process.env, platform, exec, host = OFFICIAL_HOST } = {}) {
  const setting = directory ? await readNetworkSetting(directory) : { officialProxy: 'auto' };
  if (setting.officialProxy === 'direct') return route('explicit', 'setting', null);
  if (setting.officialProxy !== 'auto') return route('explicit', 'setting', setting.officialProxy);
  const proxy = env.HTTPS_PROXY || env.https_proxy;
  if (proxy) {
    const bypassed = bypassesProxy(host, String(env.NO_PROXY || env.no_proxy || '').split(','));
    return bypassed ? route('auto', 'env', null, { bypassed: true }) : { ...route('auto', 'env', proxy), proxyEnv: env };
  }
  const system = await systemProxy({ platform, exec, host });
  if (system.proxy) return route('auto', 'system', system.proxy);
  return route('auto', 'direct', null, { ...(system.bypassed ? { bypassed: true } : {}), ...(WARNINGS.has(system.warning) ? { warning: system.warning } : {}) });
}

export const publicRoute = (resolved) => resolved ? { mode: resolved.mode, source: resolved.source,
  proxy: resolved.proxy ? redactProxy(resolved.proxy) : 'direct',
  ...(resolved.bypassed ? { bypassed: true } : {}), ...(resolved.warning ? { warning: resolved.warning } : {}) } : null;

// Re-resolved at most every NETWORK_TTL_MS and immediately after a transport
// failure, so a VPN/proxy that starts, stops or changes port takes effect
// without restarting the gateway.
export function createOfficialNetwork({ directory, env = process.env, platform, exec, ttlMs = NETWORK_TTL_MS, now = Date.now } = {}) {
  let cached = null, resolvedAt = -Infinity, inflight = null;
  return {
    resolve({ force = false } = {}) {
      if (!force && cached && now() - resolvedAt < ttlMs) return Promise.resolve(cached);
      inflight ||= resolveOfficialRoute({ directory, env, platform, exec })
        .then((resolved) => { cached = resolved; resolvedAt = now(); return resolved; })
        .finally(() => { inflight = null; });
      return inflight;
    },
    invalidate() { resolvedAt = -Infinity; },
  };
}

// The check runs inside the gateway process, whose environment can differ from
// this CLI's. It is credential-free and performs no inference.
export async function officialNetworkStatus(directory, { fetchImpl = fetch, env = process.env } = {}) {
  const setting = await readNetworkSetting(directory);
  // A proxy may be saved before configure/connect; then only this process is shown.
  const config = await loadGatewayConfig(directory).catch(() => null);
  let gateway = { running: false, reachable: null, ...(config ? {} : { reason: 'not_configured' }) };
  if (config) try {
    const response = await fetchImpl(`${gatewayURL(config)}/network`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status === 404) gateway = { running: true, reachable: null, error: 'gateway_upgrade_required' };
    else if (!response.ok) gateway = { running: true, reachable: null, error: `gateway_http_${response.status}` };
    else gateway = { running: true, ...(await response.json()).official };
  } catch { /* Not running: report this process's own resolution below. */ }
  return { setting: { officialProxy: redactProxy(setting.officialProxy), saved: setting.saved },
    gateway, ...(gateway.running ? {} : { thisProcess: publicRoute(await resolveOfficialRoute({ directory, env })) }),
    scope: 'Egress for the fixed Official endpoint only; not route identity or switch consent.' };
}

export function unreachableDetail(gateway) {
  if (!gateway?.running) return 'the gateway is not running';
  if (gateway.error === 'gateway_upgrade_required') return 'the running gateway predates this check; restart only the plugin gateway (gateway-stop, then gateway-start)';
  const via = gateway.source === 'direct' || !gateway.proxy || gateway.proxy === 'direct' ? 'a direct connection' : `${gateway.source} proxy ${gateway.proxy}`;
  return `${gateway.error || 'unreachable'} via ${via}${gateway.warning ? `; system proxy ${gateway.warning}` : ''}`;
}

export async function requireOfficialReachable(directory, options) {
  const status = await officialNetworkStatus(directory, options);
  if (status.gateway.reachable === true) return status;
  throw Object.assign(new Error(`OpenAI Official is unreachable from the gateway (${unreachableDetail(status.gateway)}). Nothing was approved and the user's reply was not used; the request stays pending. Tell the user, and after they fix network access (for example autoswitch.mjs network --official-proxy http://HOST:PORT, or starting their system proxy), ask them to confirm the switch again.`),
    { code: 'OFFICIAL_UNREACHABLE' });
}
