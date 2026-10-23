import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { openAppServer } from './app-server-client.mjs';
import { nativeIntegrationStatus } from './native-integration.mjs';
import { NATIVE_LOGINS, configPath, defaultCardId, inspectCCSwitch, loadGatewayConfig, readJSON, routeDescriptor } from './provider-config.mjs';
import { readDirectCards } from './direct-route.mjs';
import { HINTS, REASONS, listCandidates } from './switch-candidates.mjs';
import { gatewayRuntimeProblem } from './switch-gateway.mjs';
import { requireTrustedStartupHook } from './startup.mjs';

const run = promisify(execFile);
const item = (id, status, summary, fix = null) => ({ id, status, summary, ...(fix ? { fix } : {}) });
const SELECT_DEFAULT = 'or select another default Codex card in CC Switch';

async function sqliteProblem(exec = run) {
  try {
    const { stdout } = await exec('sqlite3', [':memory:', "SELECT hex(sha3('modeltrace',256))"], { timeout: 5000 });
    return /^[0-9A-F]{64}\s*$/.test(stdout) ? null : 'sqlite3 has no sha3() function';
  } catch (error) { return error.code === 'ENOENT' ? 'sqlite3 is not installed or not on PATH' : 'sqlite3 could not run sha3()'; }
}

// Where new conversations start: CCSwitch's default card, and the route the
// gateway takes there (direct, Official or CCSwitch's default route).
function defaultCardChecks(layout, cards, login) {
  let id;
  try { id = defaultCardId(layout); }
  catch (error) {
    return [error.code === 'NO_DEFAULT_CARD' ? item('default_card', 'fail', 'CCSwitch has no default Codex card', 'Select a default Codex card in CC Switch')
      : item('default_card', 'skip', 'Needs CCSwitch\'s local proxy for Codex')];
  }
  const name = JSON.stringify(layout.providers.find(provider => provider.id === id)?.name ?? '?');
  let route;
  try { route = routeDescriptor(layout, id, cards.get(id)); }
  catch (error) {
    const reason = error.code === 'DIRECT_UNUSABLE' ? error.problem : REASONS[error.code] || 'invalid_card';
    return [item('default_card', 'fail', `New conversations start on CCSwitch's default card ${name}, which cannot be used (${reason})`, `${HINTS[reason] || ''} Fix it, ${SELECT_DEFAULT}.`.trim())];
  }
  if (route.transport === 'official') {
    return [login === 'chatgpt' || login == null ? item('default_card', 'ok', `New conversations start on CCSwitch's default card ${name} (OpenAI official, current Codex login; no fingerprint monitoring)`)
      : item('default_card', 'fail', `CCSwitch's default card ${name} is OpenAI Official, which needs a ChatGPT login`, `Sign in with ChatGPT (codex login), ${SELECT_DEFAULT}`)];
  }
  if (route.transport === 'direct') return [item('default_card', 'ok', `New conversations start on CCSwitch's default card ${name} (connects directly)`)];
  // Only CCSwitch can reach this card, so a conversation on it depends on it
  // staying CCSwitch's default card, without automatic failover.
  return [item('default_card', 'ok', `New conversations start on CCSwitch's default card ${name} (through CCSwitch; a conversation on it fails once CCSwitch's default card changes)`),
    layout.listener?.auto_failover_enabled === 0 ? item('failover', 'ok', 'CCSwitch automatic failover is off')
      : item('failover', 'fail', 'CCSwitch automatic failover is on or unknown, and the default card is only usable through CCSwitch', 'In CC Switch, turn off automatic failover for Codex')];
}

/**
 * Read-only checklist for a new user's setup, in the order it is fixed:
 * runtime, Codex login and hooks, CCSwitch and its default card (where new
 * conversations start), the plugin configuration, the gateway and the ordinary
 * Codex entry. Each failed item carries its fix. Statuses: ok, todo (a setup
 * step not done yet), fail, skip (blocked by an earlier item). Nothing is
 * changed, started or trusted here; card keys never leave this process.
 */
export async function checkEnvironment(directory, env = process.env, {
  ccSwitchDirectory, gatewayStatus, cwd = process.cwd(), nodeVersion = process.versions.node,
  runtimeProblem = gatewayRuntimeProblem, sqlite = sqliteProblem, openClient = openAppServer, inspect = inspectCCSwitch,
  loadConfig = loadGatewayConfig, integration = nativeIntegrationStatus, readCards = readDirectCards, trustCheck = requireTrustedStartupHook,
  readRawConfig = directory => readJSON(configPath(directory)),
} = {}) {
  const checks = [];
  let login = null;
  const runtime = runtimeProblem(nodeVersion);
  checks.push(runtime ? item('node', 'fail', runtime, 'Install Node.js 24.5+ (or 22.21+ on the 22 line) and make it the node that Codex hooks run') : item('node', 'ok', `Node.js ${nodeVersion}`));
  const sqliteIssue = await sqlite();
  checks.push(sqliteIssue ? item('sqlite3', 'fail', sqliteIssue, 'Install the SQLite command-line shell (it includes sha3()); macOS ships one at /usr/bin/sqlite3') : item('sqlite3', 'ok', 'sqlite3 with sha3()'));

  let client = null;
  try { client = await openClient(env, { nativeOpenai: true }); }
  catch { checks.push(item('codex', 'fail', 'The Codex CLI could not be started', 'Install Codex CLI and make sure `codex` is on PATH, or set MODELTRACE_CODEX_PATH to its absolute path')); }
  if (client) {
    try {
      checks.push(item('codex', 'ok', 'Codex CLI responds'));
      let account = null;
      try { ({ account } = await client.request('account/read', { refreshToken: false })); } catch {}
      login = account?.type ?? null;
      checks.push(login === 'chatgpt' ? item('login', 'ok', 'Codex is signed in with ChatGPT')
        : NATIVE_LOGINS.includes(login) ? item('login', 'ok', `Codex is signed in (${login}); relays work, but OpenAI Official needs a ChatGPT login`)
          : item('login', 'fail', login ? `Codex login type ${login} is not supported` : 'Codex is not signed in',
            'Run `codex login`: sign in with ChatGPT (needed only for OpenAI Official), or pipe any API key to `codex login --with-api-key`; the gateway replaces it on every relay route'));
      try { await trustCheck(client, cwd); checks.push(item('hooks', 'ok', 'ModelTrace hooks are trusted')); }
      catch { checks.push(item('hooks', 'todo', 'ModelTrace hooks are not trusted yet', 'In Codex, open /hooks, review ModelTrace Guard Autoswitch and trust it')); }
    } finally { await client.close().catch(() => {}); }
  } else {
    checks.push(item('login', 'skip', 'Needs a working Codex CLI'), item('hooks', 'skip', 'Needs a working Codex CLI'));
  }

  let config = null, configProblem = null;
  try { config = await loadConfig(directory); } catch (error) { configProblem = error.code || 'INVALID'; }
  // A configuration from before 0.5 still names the CCSwitch directory in use.
  const outdated = configProblem === 'CONFIG_OUTDATED' ? await readRawConfig(directory).catch(() => null) : null;
  const ccDir = path.resolve(config?.ccSwitchDirectory || (path.isAbsolute(outdated?.ccSwitchDirectory || '') ? outdated.ccSwitchDirectory : null)
    || ccSwitchDirectory || path.join(homedir(), '.cc-switch'));
  let layout = null, cards = new Map();
  try { layout = await inspect(ccDir); }
  catch { checks.push(item('ccswitch', 'fail', `CCSwitch data could not be read in ${ccDir}`, 'Install CC Switch 4.0.15, add your Codex providers in it and open it once')); }
  if (layout) {
    checks.push(item('ccswitch', layout.providers.length ? 'ok' : 'fail', `CCSwitch has ${layout.providers.length} Codex provider card(s)`,
      layout.providers.length ? null : 'Add your Codex providers in CC Switch'));
    // CCSwitch's default card is defined only while it proxies Codex; in its
    // Direct mode it rewrites Codex's configuration and bypasses the gateway.
    const proxied = layout.mode === 'proxy' && layout.attached && !layout.pending;
    checks.push(proxied ? item('ccswitch_proxy', 'ok', 'CCSwitch runs its local proxy for Codex')
      : item('ccswitch_proxy', 'fail', layout.pending ? 'CCSwitch has a pending configuration change' : 'CCSwitch does not run its local proxy for Codex',
        'In CC Switch, open Codex and switch to Routing or Aggregation mode, then wait until it is applied'));
    try { cards = await readCards(ccDir); } catch {}
    checks.push(...defaultCardChecks(layout, cards, login));
  } else {
    checks.push(item('ccswitch_proxy', 'skip', 'Needs readable CCSwitch data'), item('default_card', 'skip', 'Needs readable CCSwitch data'));
  }

  checks.push(config ? item('configuration', 'ok', `ModelTrace is set up${config.backup ? `; recommended backup: ${config.backup.name}` : ''}`)
    : configProblem === 'NOT_CONFIGURED' ? item('configuration', 'todo', 'ModelTrace is not set up yet', 'Tell Codex “接入 ModelTrace”; it runs autoswitch.mjs connect, which also creates the configuration')
      : configProblem === 'CONFIG_OUTDATED' ? item('configuration', 'todo', 'The configuration is from before 0.5 (a fixed primary route)', 'Tell Codex “重新接入 ModelTrace”; it updates the configuration and keeps the gateway address. Conversations started before need a new conversation')
        : item('configuration', 'fail', 'The gateway configuration is invalid', 'Move gateway-config.json out of the plugin data directory, then tell Codex “接入 ModelTrace”'));

  if (config && gatewayStatus) {
    const gateway = await gatewayStatus(directory).catch(() => ({ running: false }));
    const blocked = gateway.running && gateway.readiness === 'ready' && gateway.newConversations && gateway.newConversations !== 'ready';
    checks.push(blocked ? item('gateway', 'fail', `The gateway runs, but new conversations cannot start: ${gateway.newConversations}`, 'Fix the CCSwitch items above, then check again')
      : gateway.running && gateway.readiness === 'ready' ? item('gateway', 'ok', `The ModelTrace gateway runs on port ${config.port}`)
      : gateway.readiness === 'upgrade_required' ? item('gateway', 'fail', 'The running gateway is an older version', 'Restart only the plugin gateway: autoswitch.mjs gateway-stop, then gateway-start')
        : gateway.running ? item('gateway', 'fail', `The gateway runs but is not ready: ${gateway.readiness}`, 'Fix the items above, then check again')
          : item('gateway', 'todo', 'The gateway is not running', 'It starts when you connect (tell Codex “接入 ModelTrace”) or with autoswitch.mjs gateway-start'));
  } else {
    checks.push(item('gateway', 'skip', 'Needs the ModelTrace configuration'));
  }

  const connection = config ? await integration(directory, env).catch(() => null) : null;
  checks.push(!config ? item('connection', 'skip', 'Needs the ModelTrace configuration')
    : connection?.readyForNewThreads ? item('connection', 'ok', 'New Codex conversations go through the gateway')
      : ['not_installed', 'removed'].includes(connection?.phase) || !connection ? item('connection', 'todo', 'Ordinary codex is not connected to the gateway yet', 'Tell Codex “接入 ModelTrace”; it runs autoswitch.mjs connect')
        : item('connection', 'fail', `The Codex configuration changed outside the plugin (${connection.phase}); new conversations bypass the gateway`, 'Tell Codex “重新接入 ModelTrace”; common cause: CCSwitch rewrote Codex\'s config after a card switch or restart'));

  if (layout) {
    // Any card a conversation could switch to; card keys stay in `cards`.
    const entries = listCandidates(layout, config || { backup: null }, null, new Map(), cards, login);
    const selectable = entries.filter(entry => entry.selectable).map(entry => entry.name);
    const unavailable = entries.filter(entry => !entry.selectable).map(entry => `${entry.name ?? '?'} (${entry.reason})`);
    checks.push(item('routes', selectable.length > 1 ? 'ok' : 'todo', `Usable cards: ${selectable.join(', ') || 'none'}${unavailable.length ? `; unavailable: ${unavailable.join(', ')}` : ''}`,
      selectable.length > 1 ? null : 'Add another Codex provider in CC Switch, or sign in to OpenAI Official, so a conversation has a card to switch to'));
  }
  const blocking = checks.filter(check => check.status === 'fail' || check.status === 'todo');
  return { ready: blocking.length === 0, checks, next: blocking[0]?.fix ?? null,
    note: 'Read-only check: nothing was changed, started or trusted. Fix items in order; later ones may depend on earlier ones.' };
}
