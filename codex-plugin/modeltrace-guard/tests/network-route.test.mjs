import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  bypassesProxy, createOfficialNetwork, networkPath, officialNetworkStatus, parseMacProxy, parseProxySetting, parseWindowsProxy,
  readNetworkSetting, redactProxy, requireOfficialReachable, resolveOfficialRoute, systemProxy, writeNetworkSetting,
} from '../scripts/network-route.mjs';
import { atomicJSON, configPath } from '../scripts/provider-config.mjs';

// Verbatim `scutil --proxy` layout from a Clash-style system proxy.
const MAC = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : localhost
    3 : *.local
    4 : <local>
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`;
const windows = (values) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n${
  Object.entries(values).map(([key, [type, value]]) => `    ${key}    ${type}    ${value}`).join('\r\n')}\r\n`;

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'network-route-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('macOS system proxy uses the HTTPS entry and reports unsupported PAC/SOCKS-only setups', () => {
  assert.deepEqual(parseMacProxy(MAC), { proxy: 'http://127.0.0.1:7897' });
  assert.deepEqual(parseMacProxy(MAC.replace('HTTPSEnable : 1', 'HTTPSEnable : 0').replace('SOCKSEnable : 1', 'SOCKSEnable : 0')), { proxy: null },
    'an HTTP-only entry is not used for the https:// destination, like native clients');
  assert.deepEqual(parseMacProxy(MAC.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')), { proxy: null, warning: 'socks_unsupported' });
  assert.deepEqual(parseMacProxy(MAC.replace('HTTPSEnable : 1', 'HTTPSEnable : 0').replace('ProxyAutoConfigEnable : 0', 'ProxyAutoConfigEnable : 1')),
    { proxy: null, warning: 'pac_unsupported' });
  assert.deepEqual(parseMacProxy(MAC.replace('3 : *.local', '3 : chatgpt.com')), { proxy: null, bypassed: true });
  assert.deepEqual(parseMacProxy(MAC.replace('HTTPSProxy : 127.0.0.1', 'HTTPSProxy : ::1')), { proxy: 'http://[::1]:7897' });
  assert.deepEqual(parseMacProxy('<dictionary> {\n}'), { proxy: null });
});

test('Windows Internet Settings support shared, per-protocol and bypass proxy forms', () => {
  assert.deepEqual(parseWindowsProxy(windows({ ProxyEnable: ['REG_DWORD', '0x1'], ProxyServer: ['REG_SZ', '127.0.0.1:7890'] })), { proxy: 'http://127.0.0.1:7890' });
  assert.deepEqual(parseWindowsProxy(windows({ ProxyEnable: ['REG_DWORD', '0x1'], ProxyServer: ['REG_SZ', 'http=10.0.0.1:80;https=10.0.0.2:443'] })), { proxy: 'http://10.0.0.2:443' });
  assert.deepEqual(parseWindowsProxy(windows({ ProxyEnable: ['REG_DWORD', '0x1'], ProxyServer: ['REG_SZ', 'socks=127.0.0.1:1080'] })), { proxy: null, warning: 'socks_unsupported' });
  assert.deepEqual(parseWindowsProxy(windows({ ProxyEnable: ['REG_DWORD', '0x1'], ProxyServer: ['REG_SZ', '127.0.0.1:7890'], ProxyOverride: ['REG_SZ', 'localhost;*.chatgpt.com;chatgpt.com'] })),
    { proxy: null, bypassed: true });
  assert.deepEqual(parseWindowsProxy(windows({ ProxyEnable: ['REG_DWORD', '0x0'], ProxyServer: ['REG_SZ', '127.0.0.1:7890'], AutoConfigURL: ['REG_SZ', 'http://wpad/proxy.pac'] })),
    { proxy: null, warning: 'pac_unsupported' });
  assert.deepEqual(parseWindowsProxy(windows({ ProxyEnable: ['REG_DWORD', '0x0'] })), { proxy: null });
});

test('bypass patterns match only names, never CIDR or <local> entries', () => {
  assert.equal(bypassesProxy('chatgpt.com', ['*']), true);
  assert.equal(bypassesProxy('chatgpt.com', ['*.chatgpt.com']), false, 'a subdomain wildcard does not cover the apex');
  assert.equal(bypassesProxy('chatgpt.com', ['chat*.com']), true);
  assert.equal(bypassesProxy('chatgpt.com', ['0.0.0.0/0', '<local>', '', 'example.com']), false);
});

test('proxy settings accept only auto, direct and plain http(s) proxy URLs, and never print credentials', () => {
  assert.equal(parseProxySetting(' AUTO '), 'auto');
  assert.equal(parseProxySetting('direct'), 'direct');
  assert.equal(parseProxySetting('http://127.0.0.1:7897/'), 'http://127.0.0.1:7897');
  assert.equal(parseProxySetting('https://user:pass@proxy.example:8443'), 'https://user:pass@proxy.example:8443');
  for (const value of ['socks5://127.0.0.1:1080', 'http://127.0.0.1:7897/pac', 'http://127.0.0.1:7897?x=1', 'not a url', '', undefined]) {
    assert.throws(() => parseProxySetting(value), error => error.code === 'INVALID_OFFICIAL_PROXY');
  }
  assert.equal(redactProxy('http://synthetic-user:synthetic-password@proxy.example:8080'), 'http://***@proxy.example:8080');
  assert.equal(redactProxy('auto'), 'auto');
});

test('resolution order is explicit setting, gateway HTTPS_PROXY, OS system proxy, then direct', async t => {
  const directory = await temporary(t);
  let calls = 0;
  const exec = async (file, args) => { calls++; assert.deepEqual([file, args], ['scutil', ['--proxy']]); return MAC; };
  const env = { HTTPS_PROXY: 'http://env-proxy.example:3128' };
  assert.deepEqual(await resolveOfficialRoute({ directory, env: {}, platform: 'darwin', exec }),
    { mode: 'auto', source: 'system', proxy: 'http://127.0.0.1:7897', proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:7897' } });
  const fromEnv = await resolveOfficialRoute({ directory, env, platform: 'darwin', exec });
  assert.equal(fromEnv.source, 'env'); assert.equal(fromEnv.proxyEnv, env, 'Node applies the same environment, including NO_PROXY');
  assert.equal(calls, 1, 'an environment proxy is used without consulting the OS');
  assert.deepEqual(await resolveOfficialRoute({ directory, env: { ...env, NO_PROXY: 'localhost,.chatgpt.com,chatgpt.com' }, platform: 'darwin', exec }),
    { mode: 'auto', source: 'env', proxy: null, proxyEnv: {}, bypassed: true });
  assert.deepEqual(await resolveOfficialRoute({ directory, env: {}, platform: 'linux', exec }), { mode: 'auto', source: 'direct', proxy: null, proxyEnv: {} });

  await writeNetworkSetting(directory, 'http://explicit.example:8080');
  assert.deepEqual(await resolveOfficialRoute({ directory, env, platform: 'darwin', exec }),
    { mode: 'explicit', source: 'setting', proxy: 'http://explicit.example:8080', proxyEnv: { HTTPS_PROXY: 'http://explicit.example:8080' } });
  await writeNetworkSetting(directory, 'direct');
  assert.deepEqual(await resolveOfficialRoute({ directory, env, platform: 'darwin', exec }), { mode: 'explicit', source: 'setting', proxy: null, proxyEnv: {} });
  assert.equal(calls, 1, 'only auto without an environment proxy queries the OS');
});

test('an unreadable system proxy degrades to a reported direct route instead of failing requests', async () => {
  assert.deepEqual(await systemProxy({ platform: 'darwin', exec: async () => { throw new Error('scutil missing'); } }), { proxy: null, warning: 'system_proxy_unreadable' });
  assert.deepEqual(await resolveOfficialRoute({ env: {}, platform: 'darwin', exec: async () => MAC.replace('HTTPSEnable : 1', 'HTTPSEnable : 0') }),
    { mode: 'auto', source: 'direct', proxy: null, proxyEnv: {}, warning: 'socks_unsupported' });
});

test('the gateway resolver caches briefly, re-reads after a failure, and picks up a changed system proxy', async () => {
  let clock = 0, port = 7897, calls = 0;
  const network = createOfficialNetwork({ env: {}, platform: 'darwin', ttlMs: 1000, now: () => clock,
    exec: async () => { calls++; return MAC.replaceAll('7897', String(port)); } });
  assert.equal((await network.resolve()).proxy, 'http://127.0.0.1:7897');
  port = 7890;
  assert.equal((await network.resolve()).proxy, 'http://127.0.0.1:7897', 'cached within the TTL');
  network.invalidate();
  assert.equal((await network.resolve()).proxy, 'http://127.0.0.1:7890', 'a transport failure forces re-resolution');
  port = 7891; clock = 1000;
  assert.equal((await network.resolve()).proxy, 'http://127.0.0.1:7891', 'the TTL expires without a gateway restart');
  await Promise.all([network.resolve({ force: true }), network.resolve({ force: true })]);
  assert.equal(calls, 4, 'concurrent forced resolutions share one OS query');
});

test('the saved setting is private, survives reads, and a corrupted file fails explicitly', async t => {
  const directory = await temporary(t);
  assert.deepEqual(await readNetworkSetting(directory), { officialProxy: 'auto', saved: false });
  const saved = await writeNetworkSetting(directory, 'http://synthetic-user:synthetic-password@proxy.example:8080', 42);
  assert.deepEqual(saved, { officialProxy: 'http://***@proxy.example:8080', saved: true, updatedAt: 42 });
  if (process.platform !== 'win32') assert.equal((await stat(networkPath(directory))).mode & 0o777, 0o600);
  assert.equal((await readNetworkSetting(directory)).officialProxy, 'http://synthetic-user:synthetic-password@proxy.example:8080');
  await writeFile(networkPath(directory), JSON.stringify({ officialProxy: 'socks5://x' }));
  await assert.rejects(() => readNetworkSetting(directory), error => error.code === 'INVALID_OFFICIAL_PROXY');
  await assert.rejects(() => writeNetworkSetting(directory, 'socks5://127.0.0.1:1080'), error => error.code === 'INVALID_OFFICIAL_PROXY');
});

test('the approval preflight reports the gateway process view and keeps the request pending when Official is unreachable', async t => {
  const directory = await temporary(t);
  await atomicJSON(configPath(directory), { schema: 2, id: randomUUID(), ccSwitchDirectory: directory, port: 15722,
    upstream: 'http://127.0.0.1:15721/v1', token: 'c'.repeat(64),
    primary: { id: 'primary', name: 'Primary', fingerprint: 'a'.repeat(64), transport: 'ccswitch', key: 'primary' },
    backup: { id: 'official', name: 'Official', fingerprint: 'b'.repeat(64), transport: 'official', key: null } });
  const reply = (status, official) => async (url) => {
    assert.equal(url, `http://127.0.0.1:15722/${'c'.repeat(64)}/v1/network`);
    return { ok: status === 200, status, json: async () => ({ ok: true, official }) };
  };
  const reachable = await requireOfficialReachable(directory, { fetchImpl: reply(200, { source: 'system', proxy: 'http://127.0.0.1:7897', reachable: true, statusCode: 405 }) });
  assert.equal(reachable.gateway.reachable, true);
  await assert.rejects(() => requireOfficialReachable(directory, { fetchImpl: reply(200, { mode: 'auto', source: 'direct', proxy: 'direct', reachable: false, error: 'ECONNRESET' }) }),
    error => error.code === 'OFFICIAL_UNREACHABLE' && /ECONNRESET via a direct connection/.test(error.message) && /stays pending/.test(error.message));
  await assert.rejects(() => requireOfficialReachable(directory, { fetchImpl: reply(404) }), /restart only the plugin gateway/);
  await assert.rejects(() => requireOfficialReachable(directory, { fetchImpl: async () => { throw new Error('connection refused'); } }), /gateway is not running/);
  const offline = await officialNetworkStatus(directory, { env: {}, fetchImpl: async () => { throw new Error('connection refused'); } });
  assert.equal(offline.gateway.running, false);
  assert.ok(offline.thisProcess, 'without a gateway, the CLI shows its own resolution and labels it as such');
});
