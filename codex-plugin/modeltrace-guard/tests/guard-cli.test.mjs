import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../scripts/guard.mjs', import.meta.url));

function cli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GUARD, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('guard.mjs CLI did not exit')); }, 20000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// background.mjs imports guard.mjs back. With a top-level await in the entry
// module, Node exits 13 ("unsettled top-level await") before these commands run.
test('wait and wait-switch run from the guard.mjs CLI entry without a module-cycle deadlock', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'guard-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  for (const [args, message] of [[['wait-switch', '--request', randomUUID()], /No matching switch request/], [['wait', '--confirmation', randomUUID()], /No matching confirmation batch/]]) {
    const result = await cli([...args, '--session', randomUUID(), '--data-dir', directory], env);
    assert.equal(result.code, 1, `${args[0]} exited ${result.code}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/);
    assert.match(JSON.parse(result.stderr).error, message);
  }
});
