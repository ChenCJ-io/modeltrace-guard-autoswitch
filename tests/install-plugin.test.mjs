import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installPlugin, parseInstallArgs } from '../scripts/install-plugin.mjs';

async function fixture(t) {
  const source = await mkdtemp(path.join(tmpdir(), 'modeltrace install '));
  t.after(() => rm(source, { recursive: true, force: true }));
  const files = {
    '.agents/plugins/marketplace.json': JSON.stringify({ name: 'modeltrace-autoswitch', plugins: [{ name: 'modeltrace-guard-autoswitch', source: { source: 'local', path: './codex-plugin/modeltrace-guard' } }] }),
    'codex-plugin/modeltrace-guard/.codex-plugin/plugin.json': JSON.stringify({ name: 'modeltrace-guard-autoswitch', version: '0.3.0' }),
    'codex-plugin/modeltrace-guard/package.json': JSON.stringify({ name: 'modeltrace-guard-autoswitch', version: '0.3.0' }),
    'codex-plugin/modeltrace-guard/skills/modeltrace-guard/SKILL.md': 'fixture',
    'codex-plugin/modeltrace-guard/scripts/autoswitch.mjs': '// Must never execute in installer tests.\nthrow new Error("real configure invoked");\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(source, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
  return source;
}

test('installation executes only marketplace add and plugin add without activating monitoring', async t => {
  const source = await fixture(t), calls = [], env = { CODEX_HOME: '/isolated fixture profile' };
  const result = await installPlugin({ source }, { env, run: async (...args) => { calls.push(args); } });
  assert.deepEqual(calls.map(([file, args]) => [file, args]), [
    ['codex', ['plugin', 'marketplace', 'add', source]],
    ['codex', ['plugin', 'add', 'modeltrace-guard-autoswitch@modeltrace-autoswitch']],
  ]);
  for (const [, , options] of calls) {
    assert.equal(options.shell, false);
    assert.equal(options.cwd, source);
    assert.equal(options.env, env);
  }
  assert.deepEqual(result, { installed: true, marketplace: 'modeltrace-autoswitch', plugin: 'modeltrace-guard-autoswitch', version: '0.3.0', configured: false,
    monitoringStarted: false, switchApproved: false, hookTrustChanged: false });
});

test('explicit names and executable paths remain individual argv values', async t => {
  const source = await fixture(t), calls = [];
  const backupName = 'Doro "personal" & backup; $(do-not-execute)';
  const result = await installPlugin({ source, codex: '/custom path/codex', backupName }, {
    node: '/node path/node', env: {}, run: async (...args) => { calls.push(args); },
  });
  assert.equal(result.configured, true);
  assert.equal(calls[0][0], '/custom path/codex');
  assert.equal(calls[2][0], '/node path/node');
  assert.deepEqual(calls[2][1], [path.join(source, 'codex-plugin/modeltrace-guard/scripts/autoswitch.mjs'), 'configure', '--backup-name', backupName]);
  assert.equal(calls[2][2].shell, false);
});

test('new conversations follow CCSwitch\'s default card, so there is no primary to install', async t => {
  const source = await fixture(t), calls = [];
  await assert.rejects(installPlugin({ source, primaryName: 'API2 copy' }, { run: async (...args) => { calls.push(args); } }), /Unknown installer option/);
  assert.throws(() => parseInstallArgs(['--primary-name', 'API2 copy']), /CCSwitch's default card/);
  assert.deepEqual(calls, []);
});

test('configured native executable is respected without reading authentication', async t => {
  const source = await fixture(t), files = [];
  await installPlugin({ source }, { env: { MODELTRACE_CODEX_PATH: '/native runtime/codex' }, run: async file => { files.push(file); } });
  assert.deepEqual(files, ['/native runtime/codex', '/native runtime/codex']);
});

test('invalid or incomplete configuration is rejected before any installation command', async t => {
  const source = await fixture(t), calls = [];
  for (const options of [
    { source, backupName: '' }, { source, backupName: 'Doro\0' },
    { source, primaryProvider: 'unrequested-id' }, { source: 'https://example.invalid/unpublished-repository' },
  ]) await assert.rejects(installPlugin(options, { run: async (...args) => { calls.push(args); } }));
  assert.deepEqual(calls, []);
});

test('argument parser rejects duplicate flags, unknown flags and name/id mixtures', () => {
  for (const args of [
    ['--source'], ['--source', 'one', '--source', 'two'], ['--enable', 'true'],
    ['--backup-name', 'Doro', '--backup-name', 'Other'], ['--backup-name', 'Doro', '--primary-provider', 'id'],
  ]) assert.throws(() => parseInstallArgs(args));
  assert.deepEqual(parseInstallArgs(['--backup-name', 'Doro']), { backupName: 'Doro' });
  assert.deepEqual(parseInstallArgs([]), {}, 'The backup is optional');
  assert.deepEqual(parseInstallArgs(['--help']), { help: true });
});

test('unexpected marketplace or mismatched plugin version cannot be installed', async t => {
  const source = await fixture(t), calls = [], run = async (...args) => { calls.push(args); };
  await writeFile(path.join(source, 'codex-plugin/modeltrace-guard/package.json'), JSON.stringify({ name: 'modeltrace-guard-autoswitch', version: 'different' }));
  await assert.rejects(installPlugin({ source }, { run }), /identity\/version/);
  await writeFile(path.join(source, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'modeltrace-autoswitch', plugins: [{ name: 'modeltrace-guard-autoswitch', source: { source: 'local', path: '../unrelated' } }] }));
  await assert.rejects(installPlugin({ source }, { run }), /expected local/);
  assert.deepEqual(calls, []);
});

test('an installation failure prevents all subsequent install or configure steps', async t => {
  const source = await fixture(t);
  for (const failingStep of [0, 1, 2]) {
    const calls = [];
    await assert.rejects(installPlugin({ source, backupName: 'Doro' }, { env: {}, run: async (...args) => {
      calls.push(args);
      if (calls.length - 1 === failingStep) throw new Error('fixture failure');
    } }), error => error.stage === ['marketplace-add', 'plugin-add', 'configure'][failingStep]);
    assert.equal(calls.length, failingStep + 1);
  }
});

test('the installer runs when invoked through a symlinked checkout path', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'install-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = path.join(directory, 'checkout');
  await symlink(path.dirname(path.dirname(fileURLToPath(import.meta.url))), link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [path.join(link, 'scripts', 'install-plugin.mjs'), '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /install-plugin\.mjs/);
});
