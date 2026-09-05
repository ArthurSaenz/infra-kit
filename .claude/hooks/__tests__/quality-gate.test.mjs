// The gate is the sole test signal, so what it SAYS when qa fails is load-bearing. The real
// `pnpm run qa` is never invoked: each case points the hook at a scratch project instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { runHook, HOOKS_DIR } from './helpers.mjs';
import { acquireLock, releaseLock } from '../lock.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

// Async twin of `runHook`, for the one case that must observe the hook WHILE it waits: the lock has
// to be released mid-acquire, which spawnSync cannot express.
const runHookAsync = (file, event, env) => {
  const child = spawn('node', [join(HOOKS_DIR, file)], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(event));

  return new Promise((resolve_) => {
    child.on('close', (status) => resolve_({ status, stdout, stderr }));
  });
};

// `helpers.mjs` merges `process.env`, so under a real gate every case here would inherit the
// descent flag and see a no-op. Blank it where the gate must do real work ('' is falsy).
const gateEnv = (extra) => ({ CLAUDE_HOOK_QA_NESTED: '', ...extra });

// MUST carry its own package.json: `pnpm run qa` walks upward, so a bare directory would find the
// repo root's script and launch the full-monorepo run these tests exist to avoid.
const makeScratchProject = (qaScript) => {
  const dir = join(REPO_ROOT, '.omc', `.tmp-qa-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'tmp-qa', version: '0.0.0', scripts: { qa: qaScript } }),
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// The whole point of capturing qa's output instead of letting it stream.
test("a failing qa reports the check's own output, not a generic sentence", () => {
  const project = makeScratchProject('echo "src/x.ts(4,7): error TS2322: nope" && exit 1');
  try {
    const res = runHook('quality-gate.mjs', { tool_name: 'Stop' }, { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir }) });
    assert.equal(res.status, 2, 'a failing qa must block completion');
    assert.match(res.stderr, /TS2322/, "the failing check's own output must reach the agent");
    assert.match(res.stderr, /pnpm run qa/, 'and it must say how to re-run the whole thing');
  } finally {
    project.cleanup();
  }
});

test('a qa failure with no output still produces a usable message', () => {
  const project = makeScratchProject('exit 1');
  try {
    const res = runHook('quality-gate.mjs', { tool_name: 'Stop' }, { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir }) });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /QA failed/);
  } finally {
    project.cleanup();
  }
});

// -------------------------------------------------------------------------------- the qa lock

// SKIPS rather than refuses: a peer's lock used to fail a task that was itself fine, and parallel
// subagents ping-ponged exit 2 at each other through the model. The scratch qa FAILS on purpose —
// a passing one produces no output, so "did not run qa" would hold guard or no guard.
// SCRATCH PROJECT, NEVER THE REPO ROOT — a live gate holds that lock while running `qa`, so a
// root-level acquire here failed its own precondition. That was C1.
test('a gate that cannot get the lock skips its run instead of failing the task', () => {
  const project = makeScratchProject('echo CONTENDED_QA_MUST_NOT_RUN && exit 1');
  const held = acquireLock(project.dir, { name: 'claude-qa.lock', waitMs: 0, staleMs: 900_000 });
  assert.ok(held, 'precondition: the test holds the qa lock');

  try {
    const res = runHook(
      'quality-gate.mjs',
      { tool_name: 'Stop' },
      { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir, CLAUDE_HOOK_LOCK_WAIT_MS: '0' }) },
    );
    assert.equal(res.status, 0, 'a busy gate must not fail a task that is itself fine');
    assert.doesNotMatch(
      `${res.stdout}${res.stderr}`,
      /CONTENDED_QA_MUST_NOT_RUN/,
      'and must not have run qa — the marker proves the script never ran',
    );
    assert.match(res.stderr, /skipping this run/i, 'the skip must be visible, not silent');
  } finally {
    releaseLock(held);
    project.cleanup();
  }
});

// The QUEUE half of the contract. Without it a regression to `waitMs: 0` still passes: skipping
// immediately and skipping after a wait are indistinguishable from the timeout test alone.
test('a gate waits for a busy lock and then runs, rather than skipping immediately', async () => {
  const project = makeScratchProject('echo QUEUED_QA_RAN && exit 1');
  const held = acquireLock(project.dir, { name: 'claude-qa.lock', waitMs: 0, staleMs: 900_000 });
  assert.ok(held, 'precondition: the test holds the qa lock');

  const pending = runHookAsync(
    'quality-gate.mjs',
    { tool_name: 'Stop' },
    { CLAUDE_HOOK_QA_NESTED: '', CLAUDE_PROJECT_DIR: project.dir, CLAUDE_HOOK_LOCK_WAIT_MS: '10000' },
  );

  try {
    // Long enough that the gate is provably inside its acquire loop, short enough to stay well
    // under the wait budget.
    await new Promise((resolve) => setTimeout(resolve, 400));
    releaseLock(held);

    const res = await pending;
    assert.match(res.stderr, /QUEUED_QA_RAN/, 'the gate must have waited, then run qa');
    assert.equal(res.status, 2, 'and reported the scratch failure it found');
  } finally {
    project.cleanup();
  }
});

// lock.mjs lets CLAUDE_HOOK_LOCK_WAIT_MS override the literal, and both behaviour tests above set
// it — so neither can see the SOURCE default, and a regression to `waitMs: 0` passes both. This
// reads the literal instead. Window bounded by length, matching the call-site scan in
// hook-lock.test.mjs.
test('the gate queues on a busy lock: its waitMs literal is positive, never 0', () => {
  const source = readFileSync(join(HOOKS_DIR, 'quality-gate.mjs'), 'utf8');
  const call = /\bacquireLock\(/.exec(source);
  assert.ok(call, 'precondition: the gate acquires a lock');

  const waitMs = /waitMs:\s*([\d_]+)/.exec(source.slice(call.index, call.index + 400));
  assert.ok(waitMs, 'the call site must declare a literal waitMs');
  assert.ok(
    Number(waitMs[1].replaceAll('_', '')) > 0,
    `waitMs must queue rather than refuse — found ${waitMs[1]}`,
  );
});

// The CLASS behind that instance. Scans sources rather than hardcoding a list, so a new test file
// cannot reintroduce it unnoticed.
test('no test contends on the gate lock at the repo root', () => {
  const dir = import.meta.dirname;

  for (const file of readdirSync(dir).filter((name) => name.endsWith('.test.mjs'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    const offenders = [...source.matchAll(/acquireLock\(\s*REPO_ROOT[\s\S]*?\)/g)].filter((match) =>
      match[0].includes('claude-qa.lock'),
    );

    assert.equal(
      offenders.length,
      0,
      `${file} acquires the gate's lock at the repo root — use makeScratchProject() instead`,
    );
  }
});

// The depth guard, which would stop `gate -> qa -> .claude suite -> gate` if qa ever ran that
// suite. It does not today, so this covers the guard's early return only — the flag is injected
// directly rather than reached through a real descent. The scratch qa FAILS on purpose: a passing
// one produces no gate output, so these assertions would hold guard or no guard.
test('a nested gate returns without running qa at all', () => {
  const project = makeScratchProject('echo NESTED_QA_MUST_NOT_RUN && exit 1');
  try {
    const res = runHook(
      'quality-gate.mjs',
      { tool_name: 'Stop' },
      { env: { CLAUDE_PROJECT_DIR: project.dir, CLAUDE_HOOK_QA_NESTED: '1' } },
    );
    assert.equal(res.status, 0, 'a nested gate must not block the outer completion');
    assert.doesNotMatch(
      `${res.stdout}${res.stderr}`,
      /NESTED_QA_MUST_NOT_RUN/,
      'and must not spawn qa — the marker proves the script never ran',
    );
    assert.ok(
      !existsSync(join(project.dir, 'node_modules', '.cache', 'claude-qa.lock')),
      'a nested gate must not leave a lock behind either',
    );
  } finally {
    project.cleanup();
  }
});

// THE REGRESSION THIS CATCHES: editing `.claude/hooks/*.mjs` makes the edit pipeline hold a
// repo-root lock, so a shared filename would let a prettier stage refuse a task completion.
test('a quality-gate is NOT refused while the pipeline holds the repo-root lock', () => {
  const project = makeScratchProject('exit 1');
  // The lock the EDIT PIPELINE would hold, in the same directory, under its own name.
  const pipelineLock = acquireLock(project.dir, { waitMs: 0, staleMs: 120_000 });
  assert.ok(pipelineLock, 'precondition: the pipeline holds the lock in this directory');

  try {
    const res = runHook('quality-gate.mjs', { tool_name: 'Stop' }, { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir }) });
    // Free to fail on qa itself; what it must NOT do is refuse on the lock.
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
  const res = runHook('quality-gate.mjs', { tool_name: 'Stop' }, { env: gateEnv({ CLAUDE_PROJECT_DIR: '' }) });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /failing closed/);
});

// A leaked lock would refuse every subsequent completion until staleMs (fifteen minutes) elapsed.
test('the qa lock is released even when qa fails', () => {
  const project = makeScratchProject('exit 1');
  try {
    const res = runHook('quality-gate.mjs', { tool_name: 'Stop' }, { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir }) });
    assert.equal(res.status, 2, 'a failing qa must block completion');
    assert.ok(
      !existsSync(join(project.dir, 'node_modules', '.cache', 'claude-qa.lock')),
      'the lock must be gone once the gate has reported',
    );
  } finally {
    project.cleanup();
  }
});
