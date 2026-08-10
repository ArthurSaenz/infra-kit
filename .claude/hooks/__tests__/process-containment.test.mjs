// Every spawned tool must die with its stage. With `pnpm exec <tool>`, killSignal reaches only the
// DIRECT child, so a timeout kills pnpm while the tool keeps writing — invisible without a test at
// this level, and back the first time someone "simplifies" a stage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOOKS_DIR } from './helpers.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Plants a fake `.bin/prettier` that sleeps past the 10s budget, so the stage has to kill it.
test('no descendant survives a stage timeout', () => {
  const pkgDir = join(REPO_ROOT, '.omc', '.tmp-containment-test');
  rmSync(pkgDir, { recursive: true, force: true });
  const binDir = join(pkgDir, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });

  try {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'tmp-contain', version: '0.0.0' }));

    // APPENDED: prettier runs twice, and one surviving orphan is the whole defect.
    const pidFile = join(pkgDir, 'tool.pids');

    // A TWO-PROCESS SHIM, because real `.bin` entries are `/bin/sh` cmd-shims: a bare node fake
    // would pass whether or not the shim `exec`s, which is the mechanism under test.
    const sleeper = join(pkgDir, 'sleeper.cjs');
    writeFileSync(
      sleeper,
      `require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
setTimeout(() => {}, 120000);
`,
    );
    writeFileSync(
      join(binDir, 'prettier'),
      `#!/bin/sh
echo $$ >> ${JSON.stringify(pidFile)}
exec "${process.execPath}" ${JSON.stringify(sleeper)} "$@"
`,
      { mode: 0o755 },
    );

    // No configs, so only the two prettier stages run and the runtime stays at their 10s budgets.
    writeFileSync(join(pkgDir, 'src.js'), 'const x = 1\n');

    const started = Date.now();
    const res = spawnSync('node', [join(HOOKS_DIR, 'edit-pipeline.mjs')], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(pkgDir, 'src.js') } }),
      encoding: 'utf8',
    });
    const elapsed = Date.now() - started;

    // The HOOK returns on its own stage timeouts; relying on the harness is just a later kill.
    assert.ok(elapsed < 60_000, `must return on its own stage timeouts (took ${elapsed}ms)`);

    // AND IT MUST SAY SO: discarding the result under `--log-level silent` gives a 20s stall then
    // exit 0, and the agent cannot tell a stage never ran.
    assert.equal(res.status, 2, 'an expired stage must reach the agent');
    assert.match(res.stderr, /Prettier:/, 'and must name the stage that expired');
    assert.match(res.stderr, /inconclusive \(timed out\)/, 'as inconclusive, not as a finding');

    assert.ok(existsSync(pidFile), 'the fake tool must have run at least once');
    const pids = readFileSync(pidFile, 'utf8')
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);

    assert.ok(pids.length >= 1, 'at least one stage must have spawned the tool');

    // Poll: SIGKILL delivery and reaping are not synchronous with the hook returning.
    for (const pid of pids) {
      let alive = true;
      for (let i = 0; i < 40 && alive; i += 1) {
        alive = isAlive(pid);
        if (alive) sleepSync(50);
      }
      assert.equal(alive, false, `tool pid ${pid} outlived its stage — killSignal did not reach it`);
    }
  } finally {
    rmSync(pkgDir, { recursive: true, force: true });
  }
});
