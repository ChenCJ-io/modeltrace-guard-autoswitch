import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { openAppServer } from './app-server-client.mjs';
import { nativeIntegrationStatus } from './native-integration.mjs';
import { assertProviderCurrent, inspectCCSwitch, loadGatewayConfig } from './provider-config.mjs';
import { readDirectCards } from './direct-route.mjs';
import { listCandidates } from './switch-candidates.mjs';
import { gatewayRuntimeProblem } from './switch-gateway.mjs';
import { requireTrustedStartupHook } from './startup.mjs';

const run = promisify(execFile);
const item = (id, status, summary, fix = null) => ({ id, status, summary, ...(fix ? { fix } : {}) });

async function sqliteProblem(exec = run) {
  try {
    const { stdout } = await exec('sqlite3', [':memory:', "SELECT hex(sha3('modeltrace',256))"], { timeout: 5000 });
    return /^[0-9A-F]{64}\s*$/.test(stdout) ? null : 'sqlite3 has no sha3() function';
  } catch (error) { return error.code === 'ENOENT' ? 'sqlite3 is not installed or not on PATH' : 'sqlite3 could not run sha3()'; }
}

/**
 * Read-only checklist for a new user's setup, in the order it is fixed:
 * runtime, Codex login and hooks, CCSwitch, the plugin configuration, the
 * gateway and the ordinary Codex entry. Each failed item carries its fix.
 * Statuses: ok, todo (a setup step not done yet), fail, skip (blocked by an
 * earlier item). Nothing is changed, started or trusted here.
 */
export async function checkEnvironment(directory, env = process.env, {
  ccSwitchDirectory, gatewayStatus, cwd = process.cwd(), nodeVersion = process.versions.node,
  runtimeProblem = gatewayRuntimeProblem, sqlite = sqliteProblem, openClient = openAppServer, inspect = inspectCCSwitch,
  loadConfig = loadGatewayConfig, integration = nativeIntegrationStatus, readCards = readDirectCards, trustCheck = requireTrustedStartupHook,
} = {}) {
  const checks = [];
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
      checks.push(account?.type === 'chatgpt' ? item('login', 'ok', 'Codex is signed in with ChatGPT')
        : item('login', 'fail', account?.type ? `Codex is signed in with ${account.type}; this version needs a ChatGPT login` : 'Codex is not signed in', 'Run `codex login` and sign in with your ChatGPT account'));
      try { await trustCheck(client, cwd); checks.push(item('hooks', 'ok', 'ModelTrace hooks are trusted')); }
      catch { checks.push(item('hooks', 'todo', 'ModelTrace hooks are not trusted yet', 'In Codex, open /hooks, review ModelTrace Guard Autoswitch and trust it')); }
    } finally { await client.close().catch(() => {}); }
  } else {
    checks.push(item('login', 'skip', 'Needs a working Codex CLI'), item('hooks', 'skip', 'Needs a working Codex CLI'));
  }

  let config = null;
  try { config = await loadConfig(directory); } catch {}
  const ccDir = path.resolve(config?.ccSwitchDirectory || ccSwitchDirectory || path.join(homedir(), '.cc-switch'));
  let layout = null;
  try { layout = await inspect(ccDir); }
  catch { checks.push(item('ccswitch', 'fail', `CCSwitch data could not be read in ${ccDir}`, 'Install CC Switch 4.0.15, add your Codex providers in it and open it once')); }
  if (layout) {
    checks.push(item('ccswitch', layout.providers.length ? 'ok' : 'fail', `CCSwitch has ${layout.providers.length} Codex provider card(s)`,
      layout.providers.length ? null : 'Add your Codex providers in CC Switch'));
    const proxied = layout.mode === 'proxy' && layout.attached && !layout.pending;
    checks.push(proxied ? item('ccswitch_proxy', 'ok', 'CCSwitch runs its local proxy for Codex')
      : item('ccswitch_proxy', 'fail', layout.pending ? 'CCSwitch has a pending configuration change' : 'CCSwitch does not run its local proxy for Codex',
        'In CC Switch, open Codex and switch to Routing or Aggregation mode, then wait until it is applied'));
  } else {
    checks.push(item('ccswitch_proxy', 'skip', 'Needs readable CCSwitch data'));
  }

  if (!config) {
    checks.push(item('primary', 'todo', 'No primary route is configured yet', 'Tell Codex which CCSwitch card is your primary, e.g. “主渠道用 <name>”; it runs autoswitch.mjs configure'));
  } else if (layout) {
    // The same identity check the gateway applies before every primary request.
    let primaryOk = true;
    try { assertProviderCurrent({ ...layout, primaryId: config.primary.id }, config.primary); }
    catch { primaryOk = false; }
    checks.push(primaryOk ? item('primary', 'ok', `Primary route: ${config.primary.name}${config.backup ? `; recommended backup: ${config.backup.name}` : ''}`)
      : item('primary', 'fail', `The primary card ${JSON.stringify(config.primary.name)} changed in CCSwitch or is missing, so the gateway refuses it`,
        'Choose the primary again (tell Codex “主渠道用 <name>”); conversations started before that need a new conversation'));
    if (config.primary.transport === 'ccswitch') {
      checks.push(layout.defaultProvider === config.primary.id ? item('primary_default', 'ok', 'The primary is CCSwitch\'s default card')
        : item('primary_default', 'fail', 'CCSwitch\'s default card is not the primary', `In CC Switch, make ${JSON.stringify(config.primary.name)} the default Codex card`));
      checks.push(layout.listener?.auto_failover_enabled === 0 ? item('failover', 'ok', 'CCSwitch automatic failover is off')
        : item('failover', 'fail', 'CCSwitch automatic failover is on or unknown', 'In CC Switch, turn off automatic failover for Codex'));
    }
  } else {
    checks.push(item('primary', 'skip', 'Needs readable CCSwitch data'));
  }

  if (config && gatewayStatus) {
    const gateway = await gatewayStatus(directory).catch(() => ({ running: false }));
    checks.push(gateway.running && gateway.readiness === 'ready' ? item('gateway', 'ok', `The ModelTrace gateway runs on port ${config.port}`)
      : gateway.readiness === 'upgrade_required' ? item('gateway', 'fail', 'The running gateway is an older version', 'Restart only the plugin gateway: autoswitch.mjs gateway-stop, then gateway-start')
        : gateway.running ? item('gateway', 'fail', `The gateway runs but is not ready: ${gateway.readiness}`, 'Fix the items above, then check again')
          : item('gateway', 'todo', 'The gateway is not running', 'It starts when you connect (tell Codex “接入 ModelTrace”) or with autoswitch.mjs gateway-start'));
  } else {
    checks.push(item('gateway', 'skip', 'Needs a configured primary route'));
  }

  const connection = config ? await integration(directory, env).catch(() => null) : null;
  checks.push(!config ? item('connection', 'skip', 'Needs a configured primary route')
    : connection?.readyForNewThreads ? item('connection', 'ok', 'New Codex conversations go through the gateway')
      : ['not_installed', 'removed'].includes(connection?.phase) || !connection ? item('connection', 'todo', 'Ordinary codex is not connected to the gateway yet', 'Tell Codex “接入 ModelTrace”; it runs autoswitch.mjs connect')
        : item('connection', 'fail', `The Codex configuration changed outside the plugin (${connection.phase}); new conversations bypass the gateway`, 'Tell Codex “重新接入 ModelTrace”; common cause: CCSwitch rewrote Codex\'s config after a card switch or restart'));

  if (layout && config) {
    const problems = new Map();
    try { for (const [id, card] of await readCards(ccDir)) if (card.problem) problems.set(id, card.problem); } catch {}
    const entries = listCandidates({ ...layout, primaryId: config.primary.id }, config, config.primary, new Map(), problems);
    const selectable = entries.filter(entry => entry.selectable).map(entry => entry.name);
    const unavailable = entries.filter(entry => !entry.selectable && entry.reason !== 'current_route').map(entry => `${entry.name ?? '?'} (${entry.reason})`);
    checks.push(item('routes', selectable.length ? 'ok' : 'todo', `Switch targets: ${selectable.join(', ') || 'none'}${unavailable.length ? `; unavailable: ${unavailable.join(', ')}` : ''}`,
      selectable.length ? null : 'Add another Codex provider in CC Switch, or sign in to OpenAI Official, to have a switch target'));
  }
  const blocking = checks.filter(check => check.status === 'fail' || check.status === 'todo');
  return { ready: blocking.length === 0, checks, next: blocking[0]?.fix ?? null,
    note: 'Read-only check: nothing was changed, started or trusted. Fix items in order; later ones may depend on earlier ones.' };
}
