// M4 — every spawned tool must die with its stage.
//
// THE DEFECT THIS GUARDS. Stages used to run `pnpm exec <tool>`. `spawnSync`'s killSignal reaches
// only the DIRECT child, so when a stage timed out, `pnpm` died and the tool it had launched kept
// running — and kept writing the tsbuildinfo, or rewriting the source file, AFTER the pipeline had
// released the lock. Race (b) and race (e), the two the lock exists to close, both survived the
// timeout path intact. It was entirely invisible: nothing ever observed the grandchild.
//
// Without a test at this level the orphaned-writer defect is untestable and will silently return
// the first time someone "simplifies" a stage back to `pnpm exec`.

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

// The pipeline resolves each tool to a real binary under `node_modules/.bin` and spawns THAT with
// no intermediary, which is what lets killSignal reach it. This test plants a fake `.bin/prettier`
// that sleeps far past the 10s stage budget, so the stage has to kill it.
test('no descendant survives a stage timeout', () => {
  const pkgDir = join(REPO_ROOT, '.omc', '.tmp-containment-test');
  rmSync(pkgDir, { recursive: true, force: true });
  const binDir = join(pkgDir, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });

  try {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'tmp-contain', version: '0.0.0' }));

    // Pids are APPENDED, because prettier runs twice (stages 1 and 3) and every spawned instance
    // has to be accounted for — one surviving orphan is the whole defect.
    const pidFile = join(pkgDir, 'tool.pids');

    // THE FAKE IS A TWO-PROCESS SHIM ON PURPOSE. Real `node_modules/.bin` entries are `/bin/sh`
    // cmd-shims, not node scripts, so planting a bare `#!/usr/bin/env node` file would test a
    // shape this pipeline never actually spawns — and would pass whether or not the shim `exec`s,
    // which is precisely the mechanism the containment argument rests on. The shim below records
    // ITS OWN pid and then `exec`s node, so the assertion covers the real
    // hook -> sh-shim -> node chain.
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

    // No eslint.config.* and no tsconfig.json here, so only the two prettier stages run and the
    // test's runtime stays bounded by their 10s budgets.
    writeFileSync(join(pkgDir, 'src.js'), 'const x = 1\n');

    const started = Date.now();
    const res = spawnSync('node', [join(HOOKS_DIR, 'edit-pipeline.mjs')], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(pkgDir, 'src.js') } }),
      encoding: 'utf8',
    });
    const elapsed = Date.now() - started;

    // The HOOK returns on its OWN stage timeouts. A design in which the harness timeout is the
    // enforcing mechanism has no containment at all — it just has a later kill.
    assert.ok(elapsed < 60_000, `must return on its own stage timeouts (took ${elapsed}ms)`);

    // AND IT MUST SAY SO. This assertion previously pinned the WRONG behavior — `status === 0` with
    // no output — because the prettier stage discarded its result and `--log-level silent` hid the
    // tool's own voice. The observable effect was a twenty-second stall followed by nothing at all:
    // the agent waited, learned nothing, and had no way to know a stage had not run. A stage that
    // cannot report its own expiry is a stage the agent cannot reason about.
    assert.equal(res.status, 2, 'an expired stage must reach the agent');
    assert.match(res.stderr, /Prettier:/, 'and must name the stage that expired');
    assert.match(res.stderr, /inconclusive \(timed out\)/, 'as inconclusive, not as a finding');

    assert.ok(existsSync(pidFile), 'the fake tool must have run at least once');
    const pids = readFileSync(pidFile, 'utf8')
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);

    assert.ok(pids.length >= 1, 'at least one stage must have spawned the tool');

    // Poll rather than assert instantly: SIGKILL delivery and reaping are not synchronous with the
    // hook process returning to us.
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
