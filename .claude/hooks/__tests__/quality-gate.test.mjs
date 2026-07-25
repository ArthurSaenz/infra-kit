// The TaskCompleted gate is now the SOLE test signal, so what it SAYS when qa fails is
// load-bearing. The old version ran qa with `stdio: 'inherit'` and emitted one generic sentence:
// the agent learned that qa failed and never which check, which package, or why.
//
// The parser is imported directly rather than exercised through a real `pnpm run qa`, which would
// take minutes and make the suite depend on the whole monorepo being green. The fixture below is
// LITERAL captured turbo output, so the parse contract is pinned to what turbo actually prints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runHook, HOOKS_DIR } from './helpers.mjs';
import { parseQaFailures } from '../quality-gate.mjs';
import { acquireLock, releaseLock } from '../lock.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

// LITERAL capture of
//   turbo run eslint-check ts-check --continue --output-logs=errors-only
//        --log-prefix=task --log-order=grouped
// with a deliberate unused variable introduced in one package. Two failing pairs, because
// `--continue` means a failing run routinely produces several — the reason this parser must never
// be written as "the failing pair".
const TURBO_TWO_FAILURES = `   • Remote caching disabled

@wl/web-toolkit:ts-check: cache miss, executing aac8b847d92f0b04
@wl/web-toolkit:ts-check: $ tsc --noEmit
@wl/web-toolkit:ts-check: src/cn/cn.ts(18,7): error TS6133: 'unusedFixtureVar' is declared but its value is never read.
@wl/web-toolkit:ts-check: [ELIFECYCLE] Command failed with exit code 2.
@wl/web-toolkit#ts-check:  WARNING  command finished with error, but continuing...
@wl/web-toolkit:eslint-check: cache miss, executing a8fa157c1e1ae77c
@wl/web-toolkit:eslint-check: $ pnpm exec eslint --cache --quiet ./src
@wl/web-toolkit:eslint-check: /repo/vendor/packages/web-toolkit/src/cn/cn.ts
@wl/web-toolkit:eslint-check:   18:7  error  'unusedFixtureVar' is assigned a value but never used  unused-imports/no-unused-vars
@wl/web-toolkit:eslint-check: ✖ 1 problem (1 error, 0 warnings)
@wl/web-toolkit:eslint-check: [ELIFECYCLE] Command failed with exit code 1.
@wl/web-toolkit#eslint-check:  WARNING  command finished with error, but continuing...

 Tasks:    4 successful, 6 total
Cached:    4 cached, 6 total
  Time:    3.555s
Failed:    @wl/web-toolkit#eslint-check, @wl/web-toolkit#ts-check

 ERROR  run failed: command  exited (2)
`;

// AC21 / M-3c.
test('multiple failing turbo tasks are all reported, capped at 3', () => {
  const parsed = parseQaFailures(TURBO_TWO_FAILURES);

  assert.equal(parsed.kind, 'turbo');
  assert.equal(parsed.total, 2, 'BOTH failures, not just the first — --continue produces several');
  assert.deepEqual(
    parsed.failures.map((f) => f.name),
    ['@wl/web-toolkit#eslint-check', '@wl/web-toolkit#ts-check'],
  );

  // Each pair carries its own log tail, so the agent gets the actual diagnostic and not merely a
  // task name it would have to re-run to understand.
  const tsCheck = parsed.failures.find((f) => f.name === '@wl/web-toolkit#ts-check');
  assert.match(tsCheck.tail, /TS6133/, "the failing task's own output must be attached");
  assert.match(tsCheck.reproduce, /pnpm --filter @wl\/web-toolkit run ts-check/);

  const eslintCheck = parsed.failures.find((f) => f.name === '@wl/web-toolkit#eslint-check');
  assert.match(eslintCheck.tail, /no-unused-vars/);
  // Log lines are attributed by pair, so one task's output never bleeds into another's report.
  assert.doesNotMatch(eslintCheck.tail, /TS6133/);
});

test('more than three failing tasks are capped and the remainder counted', () => {
  const many = `Failed:    a#test, b#test, c#test, d#test, e#test\n`;
  const parsed = parseQaFailures(many);
  assert.equal(parsed.total, 5, 'the COUNT must be honest even when the list is truncated');
  assert.equal(parsed.failures.length, 3, 'at most three are rendered, to stay inside the budget');
});

// AC22 / M-3d. `test:hooks` is chained with `&&` OUTSIDE turbo, so its failure carries no
// `<pkg>:<task>:` prefix. Without a named branch, the safety net for this entire pipeline would be
// the one failure the reporter could not identify.
test('a test:hooks failure is named', () => {
  const output = `vendor:check passed

 Tasks:    12 successful, 12 total

> starter-workspace@1.0.0 test:hooks
> node --test .claude/hooks/__tests__/

not ok 3 - a lock older than staleMs is stolen
  ---
  error: 'a healthy holder is NOT stolen from'
  ...
# fail 1
`;

  const parsed = parseQaFailures(output);
  assert.equal(parsed.kind, 'test:hooks');
  assert.equal(parsed.failures[0].name, 'test:hooks failed');
  assert.equal(parsed.failures[0].reproduce, 'pnpm run test:hooks');
  assert.match(parsed.failures[0].tail, /not ok 3/, 'with its own tail, not an opaque "qa failed"');
});

test('a failure with no parseable check is reported as "did not run", not as findings', () => {
  // `vendor:check` failing short-circuits the whole chain before any check reports. "Failed to run
  // at all" and "a check reported problems" are different outcomes and must not be collapsed.
  const parsed = parseQaFailures('ERROR: Missing vendor/.sync-manifest.json. Re-run the vendor sync.\n');
  assert.equal(parsed.kind, 'unparsed');
  assert.equal(parsed.failures.length, 0);
  assert.match(parsed.tail, /sync-manifest/);
});

// -------------------------------------------------------------------------------- the qa lock

// AC20. Refusing is correct for TaskCompleted — it must not pass unverified — and it is cheap. The
// alternative is a second concurrent full-monorepo turbo run contending on the turbo cache, the
// eslint cache and every package's tsbuildinfo.
test('a second concurrent quality-gate is refused', () => {
  const held = acquireLock(REPO_ROOT, { name: 'claude-qa.lock', waitMs: 0, staleMs: 900_000 });
  assert.ok(held, 'precondition: the test holds the qa lock');

  try {
    const res = runHook('quality-gate.mjs', { tool_name: 'Stop' }, { env: { CLAUDE_PROJECT_DIR: REPO_ROOT } });
    assert.equal(res.status, 2, 'a busy gate must block, never pass unverified');
    assert.match(res.stderr, /another quality gate is already running/i);
    // The refusal must tell the agent how to recover. Two subagents finishing in lockstep can
    // ping-pong refusals; that is not a deadlock, and the way out is the agent's own retry.
    assert.match(res.stderr, /re-run when it completes/i);
  } finally {
    releaseLock(held);
  }
});

// AC20, second half / M-1. THE REGRESSION THIS CATCHES: `findPackageDir` returns the repo root for
// root-level files, so editing `.claude/hooks/*.mjs` makes the edit pipeline hold
// `<repoRoot>/node_modules/.cache/claude-hook.lock`. If the gate shared that filename, a routine
// 1-10s prettier stage would refuse a task completion with "another quality gate is already
// running" — false, and pointing at the wrong subsystem. The earlier version of this test could not
// have detected it: it planted an already-held lock of the only name that existed.
// A scratch project whose `qa` fails instantly, so the gate's failure path can be exercised without
// running the real monorepo qa. It MUST carry its own package.json: `pnpm run qa` walks upward, so
// a bare directory would find the repo root's script and launch the very full-monorepo run these
// tests exist to avoid.
function makeScratchProject(qaScript) {
  const dir = join(REPO_ROOT, '.omc', `.tmp-qa-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'tmp-qa', version: '0.0.0', scripts: { qa: qaScript } }),
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// AC20, second half / M-1. THE REGRESSION THIS CATCHES: `findPackageDir` returns the repo root for
// root-level files, so editing `.claude/hooks/*.mjs` makes the edit pipeline hold
// `<repoRoot>/node_modules/.cache/claude-hook.lock`. If the gate shared that filename, a routine
// 1-10s prettier stage would refuse a task completion with "another quality gate is already
// running" — false, and pointing at the wrong subsystem. The earlier version of this test could not
// have detected it: it planted an already-held lock of the only name that existed.
test('a quality-gate is NOT refused while the pipeline holds the repo-root lock', () => {
  const project = makeScratchProject('exit 1');
  // The lock the EDIT PIPELINE would hold, in the same directory, under its own name.
  const pipelineLock = acquireLock(project.dir, { waitMs: 0, staleMs: 120_000 });
  assert.ok(pipelineLock, 'precondition: the pipeline holds the lock in this directory');

  try {
    const res = runHook('quality-gate.mjs', { tool_name: 'Stop' }, { env: { CLAUDE_PROJECT_DIR: project.dir } });
    // It is free to fail on qa itself — that is what `exit 1` is for. What it must NOT do is refuse
    // on the lock, which would mean the two locks are the same file.
    assert.doesNotMatch(
      res.stderr,
      /another quality gate is already running/i,
      'the pipeline lock and the qa lock must be independent files',
    );
  } finally {
    releaseLock(pipelineLock);
    project.cleanup();
  }
});

test('quality-gate fails closed when CLAUDE_PROJECT_DIR is unset (exit 2)', () => {
  const res = runHook('quality-gate.mjs', { tool_name: 'Stop' }, { env: { CLAUDE_PROJECT_DIR: '' } });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /failing closed/);
});

// The gate must not leave its lock behind for the next task completion to trip over — a leaked lock
// would refuse every subsequent completion until staleMs (fifteen minutes) elapsed.
test('the qa lock is released even when qa fails', () => {
  const project = makeScratchProject('exit 1');
  try {
    const res = runHook('quality-gate.mjs', { tool_name: 'Stop' }, { env: { CLAUDE_PROJECT_DIR: project.dir } });
    assert.equal(res.status, 2, 'a failing qa must block completion');
    assert.ok(
      !existsSync(join(project.dir, 'node_modules', '.cache', 'claude-qa.lock')),
      'the lock must be gone once the gate has reported',
    );
  } finally {
    project.cleanup();
  }
});
