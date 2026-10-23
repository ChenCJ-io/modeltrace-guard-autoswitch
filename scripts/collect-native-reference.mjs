#!/usr/bin/env node
// Explicitly invoked live collection only. Ordinary plugin use never runs this.
import { spawnSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectNativeReference } from '../codex-plugin/modeltrace-guard/scripts/native-enrollment.mjs';
import { dataDirectory } from '../codex-plugin/modeltrace-guard/scripts/state.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function parseOptions(args) {
  const options = { effort: 'max', split: 'train', offset: 0, timeoutSeconds: 180, providerName: 'OpenAI Official' };
  const flags = { '--model': 'model', '--plugin-root': 'pluginRoot', '--output': 'output',
    '--reasoning-effort': 'effort', '--split': 'split', '--offset': 'offset', '--limit': 'limit',
    '--timeout-seconds': 'timeoutSeconds', '--provider-name': 'providerName', '--data-dir': 'directory', '--suite-json': 'suiteJSON',
    '--max-credits': 'maxCredits' };
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    if (flag === '--help') return { help: true };
    const key = flags[flag];
    if (!key || seen.has(key) || !args.length || args[0].startsWith('--')) throw new Error('Invalid or duplicate collection argument');
    seen.add(key); options[key] = args.shift();
  }
  for (const key of ['offset', 'timeoutSeconds', 'limit']) {
    if (options[key] !== undefined) {
      options[key] = Number(options[key]);
      if (!Number.isInteger(options[key]) || options[key] < (key === 'offset' ? 0 : 1)) throw new Error(`Invalid ${key}`);
    }
  }
  if (options.maxCredits !== undefined) options.maxCredits = Number(options.maxCredits);
  if (!options.model || !path.isAbsolute(options.pluginRoot || '') || !path.isAbsolute(options.output || '')) {
    throw new Error('--model, --plugin-root and --output must identify an exact model, installed plugin and new absolute output directory');
  }
  return options;
}

async function installedRuntime(root) {
  const resolved = await realpath(root);
  const manifest = JSON.parse(await readFile(path.join(resolved, '.codex-plugin', 'plugin.json'), 'utf8'));
  if (manifest.name !== 'modeltrace-guard-autoswitch') throw new Error('Incorrect installed plugin');
  const modules = await Promise.all(['app-server-client', 'fork-runner', 'provider-config', 'switch-policy'].map(name =>
    import(pathToFileURL(path.join(resolved, 'scripts', `${name}.mjs`)).href)));
  const names = ['AppServerClient', 'CODEX_CLIENT_INFO', 'codexExecutable', 'disabledHooksOverride', 'openAppServer',
    'requireTrustedGuard', 'generateProbe', 'assertProviderCurrent', 'gatewayURL', 'loadGatewayConfig',
    'resolveProvider', 'verifyGatewayReady', 'readReceipt'];
  const combined = Object.assign({}, ...modules);
  return Object.fromEntries(names.map(name => [name, combined[name]]));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('node scripts/collect-native-reference.mjs --plugin-root INSTALLED_CACHE --model EXACT_MODEL --output NEW_ABSOLUTE_DIRECTORY [--reasoning-effort max] [--split train|heldout] [--offset 0] [--limit 36] [--suite-json FILE] [--max-credits 35]\n');
    return;
  }
  let suite;
  if (options.suiteJSON) suite = JSON.parse(await readFile(path.resolve(options.suiteJSON), 'utf8'));
  else {
    const loaded = spawnSync('python3', ['-c', 'import json; from challenge_suite import fingerprint_suite; print(json.dumps(fingerprint_suite()))'],
      { cwd: repo, encoding: 'utf8' });
    if (loaded.status !== 0) throw new Error('Cannot load the canonical fingerprint suite');
    suite = JSON.parse(loaded.stdout);
  }
  if (!Array.isArray(suite)) throw new Error('The reference suite must be a JSON array');
  suite = suite.slice(options.offset, options.limit === undefined ? undefined : options.offset + options.limit);
  const summary = await collectNativeReference({ ...options, directory: dataDirectory(options.directory), suite },
    await installedRuntime(options.pluginRoot), value => process.stdout.write(JSON.stringify(value) + '\n'));
  if (summary.status !== 'completed') process.exitCode = 1;
}

main().catch(error => { process.stderr.write(JSON.stringify({ status: 'failed', error: error.message }) + '\n'); process.exitCode = 1; });
