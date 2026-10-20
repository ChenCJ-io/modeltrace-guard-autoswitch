#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from './state.mjs';
import { nativeIntegrationStatus } from './native-integration.mjs';
// Keep this import lazy: `autoswitch connect` imports the trust check while its
// CLI top-level await is active. A static import back would deadlock that CLI.
const startGateway = async directory => (await import('./autoswitch.mjs')).startGateway(directory);

export async function requireTrustedStartupHook(client, cwd) {
  const listing = await client.request('hooks/list', { cwds: [cwd] });
  const hooks = (listing.data || []).flatMap(entry => entry.hooks || []);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const expected = hash(await readFile(fileURLToPath(import.meta.url)));
  for (const hook of hooks) {
    if (!hook.enabled || !['trusted', 'managed'].includes(hook.trustStatus) || hook.eventName !== 'sessionStart'
      || hook.async !== false || hook.handlerType !== 'command'
      || !/^modeltrace-guard-autoswitch(?:@|$)/.test(hook.pluginId || '') || !hook.command?.includes('startup.mjs')) continue;
    try {
      if (hash(await readFile(path.resolve(path.dirname(hook.sourcePath), '../scripts/startup.mjs'))) === expected) return;
    } catch {}
  }
  throw new Error('Review the updated synchronous ModelTrace startup hook in /hooks before connecting ordinary Codex. No trust-changing action was performed');
}

// A synchronous startup hook supplies transport readiness before the first
// request. It never enables monitoring or rewrites user/CCSwitch preferences.
export async function ensureGatewayForStartup(event, directory, env = process.env, {
  integrationStatus = nativeIntegrationStatus, start = startGateway,
} = {}) {
  if (env.MODELTRACE_PROBE_PROCESS === '1' || event?.hook_event_name !== 'SessionStart'
    || event.agent_id || event.parent_session_id) return {};
  try {
    const connection = await integrationStatus(directory, env);
    if (['not_installed', 'removed'].includes(connection.phase)) return {};
    if (!connection.readyForNewThreads) return { systemMessage:
      'ModelTrace: ordinary Codex gateway setup is no longer current. Check connection-status before enabling; existing provider choices were not changed and monitoring was not enabled.' };
    const gateway = await start(directory);
    if (!gateway.running || gateway.readiness !== 'ready') throw new Error('Gateway is not ready');
    return {};
  } catch {
    return { systemMessage: 'ModelTrace: the configured local gateway could not be prepared. Check connection-status and gateway-status; do not claim this conversation is monitored or silently switch providers.' };
  }
}

export async function main(env = process.env) {
  let bytes = '';
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk;
      if (bytes.length > 1024 * 1024) throw new Error('Startup hook input exceeds limit');
    }
    process.stdout.write(JSON.stringify(await ensureGatewayForStartup(JSON.parse(bytes), dataDirectory(undefined, env), env)) + '\n');
  } catch { process.stdout.write(JSON.stringify({ systemMessage: 'ModelTrace startup readiness check failed; monitoring was not enabled.' }) + '\n'); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
