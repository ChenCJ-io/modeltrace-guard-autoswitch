#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const entrypoint = fileURLToPath(import.meta.url);
const defaultSource = path.resolve(path.dirname(entrypoint), '..');
const marketplaceName = 'modeltrace-autoswitch';
const pluginName = 'modeltrace-guard-autoswitch';
const pluginRelativePath = './codex-plugin/modeltrace-guard';

export function parseInstallArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const allowed = new Map([
    ['--source', 'source'], ['--codex', 'codex'],
    ['--primary-name', 'primaryName'], ['--backup-name', 'backupName'],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], key = allowed.get(flag), value = args[index + 1];
    if (!key || Object.hasOwn(options, key) || typeof value !== 'string' || !value.trim() || value.includes('\0') || value.startsWith('--')) {
      throw new Error(`Invalid installer option: ${flag}`);
    }
    options[key] = value;
  }
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  for (const key of Object.keys(options)) {
    if (!['source', 'codex', 'primaryName', 'backupName'].includes(key)) throw new Error(`Unknown installer option: ${key}`);
    if (typeof options[key] !== 'string' || !options[key].trim() || options[key].includes('\0')) throw new Error(`Invalid installer value: ${key}`);
  }
  const primary = Object.hasOwn(options, 'primaryName'), backup = Object.hasOwn(options, 'backupName');
  if (primary !== backup) throw new Error('Provide both --primary-name and --backup-name, or neither');
  if (primary && options.primaryName === options.backupName) throw new Error('Primary and backup names must differ');
  if (options.source && /^[a-z][a-z\d+.-]*:\/\//i.test(options.source)) throw new Error('Use a local checkout; read INSTALL.md before obtaining a repository URL');
}

async function inspectSource(source, configure) {
  const marketplace = JSON.parse(await readFile(path.join(source, '.agents/plugins/marketplace.json'), 'utf8'));
  const matches = marketplace.plugins?.filter(item => item.name === pluginName) || [];
  const entry = matches[0];
  if (marketplace.name !== marketplaceName || matches.length !== 1 || entry.source?.source !== 'local' || entry.source.path !== pluginRelativePath) {
    throw new Error('Source is not the expected local ModelTrace Guard Autoswitch marketplace');
  }
  const pluginRoot = path.join(source, pluginRelativePath);
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
  const packageInfo = JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8'));
  if (manifest.name !== pluginName || packageInfo.name !== pluginName || typeof manifest.version !== 'string' || !manifest.version || manifest.version !== packageInfo.version) {
    throw new Error('Plugin manifest and package identity/version must match');
  }
  await access(path.join(pluginRoot, 'skills/modeltrace-guard/SKILL.md'));
  const configureScript = path.join(pluginRoot, 'scripts/autoswitch.mjs');
  if (configure) await access(configureScript);
  return { version: manifest.version, configureScript };
}

export async function installPlugin(options = {}, { run = execute, env = process.env, node = process.execPath } = {}) {
  validateOptions(options);
  const source = path.resolve(options.source || defaultSource);
  const configure = Object.hasOwn(options, 'primaryName');
  const { version, configureScript } = await inspectSource(source, configure);
  const codex = options.codex || env.MODELTRACE_CODEX_PATH || 'codex';
  const commands = [
    { stage: 'marketplace-add', file: codex, args: ['plugin', 'marketplace', 'add', source] },
    { stage: 'plugin-add', file: codex, args: ['plugin', 'add', `${pluginName}@${marketplaceName}`] },
  ];
  if (configure) commands.push({ stage: 'configure', file: node, args: [configureScript, 'configure', '--primary-name', options.primaryName, '--backup-name', options.backupName] });
  for (const command of commands) {
    try {
      await run(command.file, command.args, { cwd: source, env, shell: false, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: 120000 });
    } catch (cause) {
      const error = new Error(`Installer stopped at ${command.stage}: ${cause.message}`, { cause });
      error.stage = command.stage;
      throw error;
    }
  }
  return { installed: true, marketplace: marketplaceName, plugin: pluginName, version, configured: configure,
    monitoringStarted: false, switchApproved: false, hookTrustChanged: false };
}

const usage = 'node scripts/install-plugin.mjs [--source LOCAL_CHECKOUT] [--codex CODEX_EXECUTABLE] [--primary-name NAME --backup-name NAME]\nInstalls the local plugin; optional names only configure preferences. No monitoring, route switch, credential access or hook trust changes.\n';

if (process.argv[1] && path.resolve(process.argv[1]) === entrypoint) {
  try {
    const options = parseInstallArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(usage);
    else process.stdout.write(`${JSON.stringify(await installPlugin(options))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, ...(error.stage ? { stage: error.stage } : {}) })}\n`);
    process.exitCode = 1;
  }
}
