// The gate is the sole test signal, so what it SAYS when qa fails is load-bearing. The real
// `pnpm run qa` is never invoked: each case points the hook at a scratch project instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { hookEnv, runHook, HOOKS_DIR, SCRATCH_LOG_DIR } from './helpers.mjs';
import { acquireLock, releaseLock } from '../lock.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

// Async twin of `runHook`, for the one case that must observe the hook WHILE it waits: the lock has
// to be released mid-acquire, which spawnSync cannot express.
const runHookAsync = (file, event, env) => {
  const child = spawn('node', [join(HOOKS_DIR, file)], { env: hookEnv(env) });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(event));

  const done = new Promise((resolve_) => {
    child.on('close', (status) => resolve_({ status, stdout, stderr }));
  });
  return Object.assign(done, { child });
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
    const res = runHook('quality-gates.mjs', { tool_name: 'Stop' }, { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir }) });
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
    const res = runHook('quality-gates.mjs', { tool_name: 'Stop' }, { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir }) });
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
      'quality-gates.mjs',
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
    'quality-gates.mjs',
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
  const source = readFileSync(join(HOOKS_DIR, 'quality-gates.mjs'), 'utf8');
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

// The depth guard, which stops `gate -> qa -> .claude suite -> gate`: qa runs that suite
// (`test:claude`). This covers the guard's early return only — the flag is injected directly
// rather than reached through a real descent. The scratch qa FAILS on purpose: a passing
// one produces no gate output, so these assertions would hold guard or no guard.
test('a nested gate returns without running qa at all', () => {
  const project = makeScratchProject('echo NESTED_QA_MUST_NOT_RUN && exit 1');
  try {
    const res = runHook(
      'quality-gates.mjs',
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
test('a quality-gates is NOT refused while the pipeline holds the repo-root lock', () => {
  const project = makeScratchProject('exit 1');
  // The lock the EDIT PIPELINE would hold, in the same directory, under its own name.
  const pipelineLock = acquireLock(project.dir, { waitMs: 0, staleMs: 120_000 });
  assert.ok(pipelineLock, 'precondition: the pipeline holds the lock in this directory');

  try {
    const res = runHook('quality-gates.mjs', { tool_name: 'Stop' }, { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir }) });
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

test('quality-gates fails closed when CLAUDE_PROJECT_DIR is unset (exit 2)', () => {
  const res = runHook('quality-gates.mjs', { tool_name: 'Stop' }, { env: gateEnv({ CLAUDE_PROJECT_DIR: '' }) });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /failing closed/);
});

// A leaked lock would refuse every subsequent completion until staleMs (fifteen minutes) elapsed.
test('the qa lock is released even when qa fails', () => {
  const project = makeScratchProject('exit 1');
  try {
    const res = runHook('quality-gates.mjs', { tool_name: 'Stop' }, { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir }) });
    assert.equal(res.status, 2, 'a failing qa must block completion');
    assert.ok(
      !existsSync(join(project.dir, 'node_modules', '.cache', 'claude-qa.lock')),
      'the lock must be gone once the gate has reported',
    );
  } finally {
    project.cleanup();
  }
});

// -------------------------------------------------------------------------------------- wait log

const freshLogDir = () => join(REPO_ROOT, '.omc', `.tmp-gate-waits-${randomUUID()}`);

const readWaits = (dir) => {
  const path = join(dir, 'waits.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

test('a gate logs a start and an end record with the qa outcome', () => {
  for (const [script, outcome] of [
    ['exit 0', 'ran'],
    ['exit 1', 'failed'],
  ]) {
    const project = makeScratchProject(script);
    const logDir = freshLogDir();
    try {
      runHook(
        'quality-gates.mjs',
        { tool_name: 'Stop' },
        { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir, CLAUDE_HOOK_LOG_DIR: logDir }) },
      );
      const [start, end] = readWaits(logDir);
      assert.equal(start.event, 'start');
      assert.equal(start.lock, true);
      assert.ok(Number.isInteger(start.waitedMs));
      assert.equal(end.event, 'end');
      assert.equal(end.id, start.id, 'end pairs with its start');
      assert.equal(end.outcome, outcome);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      project.cleanup();
    }
  }
});

test('a skipped gate is in the log, not only on stderr', () => {
  const project = makeScratchProject('exit 1');
  const logDir = freshLogDir();
  const held = acquireLock(project.dir, { name: 'claude-qa.lock', waitMs: 0, staleMs: 900_000 });

  try {
    runHook(
      'quality-gates.mjs',
      { tool_name: 'Stop' },
      {
        env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir, CLAUDE_HOOK_LOCK_WAIT_MS: '0', CLAUDE_HOOK_LOG_DIR: logDir }),
      },
    );
    assert.deepEqual(
      readWaits(logDir).map(({ event, outcome, lock }) => [event, outcome ?? lock]),
      [
        ['start', false],
        ['end', 'skipped'],
      ],
    );
  } finally {
    releaseLock(held);
    rmSync(logDir, { recursive: true, force: true });
    project.cleanup();
  }
});

test('an unwritable wait log never stops the gate from running qa', () => {
  const project = makeScratchProject('echo QA_RAN_WITHOUT_LOG && exit 1');
  const blocker = join(project.dir, 'not-a-dir');
  writeFileSync(blocker, '');

  try {
    const res = runHook(
      'quality-gates.mjs',
      { tool_name: 'Stop' },
      { env: gateEnv({ CLAUDE_PROJECT_DIR: project.dir, CLAUDE_HOOK_LOG_DIR: join(blocker, 'waits') }) },
    );
    assert.equal(res.status, 2, 'qa still ran and its failure still blocks');
    assert.match(res.stderr, /QA_RAN_WITHOUT_LOG/);
    assert.match(res.stderr, /wait log not written/, 'the lost record is reported');
  } finally {
    project.cleanup();
  }
});

// `qa` runs this very suite inside a real gate. A hook spawned here without the scratch dir would
// append test runs to the user's real log and skew the skip rate it exists to measure.
test('every gate this suite spawns writes to a scratch wait log', () => {
  assert.ok(!SCRATCH_LOG_DIR.includes(join('.cache', 'claude-hooks')), 'the default is a scratch dir');
  assert.equal(hookEnv().CLAUDE_HOOK_LOG_DIR, SCRATCH_LOG_DIR);

  // Only the gate writes the log: a direct spawn of quality-gates.mjs, or of a hook named by a
  // variable, which is how the async twin reaches it.
  const gateSpawn = /spawn(?:Sync)?\(\s*'node',\s*\[\s*join\(HOOKS_DIR,\s*(?:'quality-gates\.mjs'|[a-z]\w*)\s*\)/g;
  const dir = import.meta.dirname;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.test.mjs'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const match of source.matchAll(gateSpawn)) {
      assert.match(
        source.slice(match.index, match.index + 200),
        /hookEnv\(/,
        `${file} spawns a hook without hookEnv() — use runHook or hookEnv`,
      );
    }
  }
});

// --------------------------------------------------------------------------------- qa deadline

test('the qa deadline leaves the harness room: 600s minus margin minus grace', () => {
  const source = readFileSync(join(HOOKS_DIR, 'quality-gates.mjs'), 'utf8');
  const constant = (name) => Number(new RegExp(`const ${name} = ([\\d_]+);`).exec(source)?.[1].replaceAll('_', ''));

  assert.equal(constant('HARNESS_MS'), 600_000, 'must match the TaskCompleted timeout in settings.json');
  assert.equal(constant('MARGIN_MS'), 20_000);
  assert.equal(constant('GRACE_MS'), 10_000);
  assert.match(source, /const QA_DEADLINE_MS = HARNESS_MS - MARGIN_MS - GRACE_MS;/);

  const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const gate = settings.hooks.TaskCompleted.flatMap(({ hooks }) => hooks).find(({ command }) =>
    command.includes('quality-gates.mjs'),
  );
  assert.equal(gate.timeout * 1000, constant('HARNESS_MS'));
});

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// qa leader that ignores nothing, plus a grandchild in ITS OWN process group that ignores SIGINT:
// the shape of turbo's tasks, which a group signal to qa never reaches.
const makeHangingProject = ({ withGrandchild }) => {
  const project = makeScratchProject('node hang.mjs');
  const pidFile = join(project.dir, 'pids');
  writeFileSync(
    join(project.dir, 'hang.mjs'),
    `
    import { spawn } from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
    if (${withGrandchild}) {
      const task = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: 'ignore',
      });
      appendFileSync(${JSON.stringify(pidFile)}, task.pid + '\\n');
    }
    setInterval(() => {}, 1000);
    `,
  );
  const pids = () =>
    existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  return { ...project, pids };
};

test('a qa past the deadline is stopped with its whole tree, logged, and does not block', () => {
  const project = makeHangingProject({ withGrandchild: true });
  const logDir = freshLogDir();

  try {
    const res = runHook(
      'quality-gates.mjs',
      { tool_name: 'Stop' },
      {
        env: gateEnv({
          CLAUDE_PROJECT_DIR: project.dir,
          CLAUDE_HOOK_LOG_DIR: logDir,
          CLAUDE_HOOK_QA_DEADLINE_MS: '4000',
          CLAUDE_HOOK_QA_GRACE_MS: '500',
        }),
      },
    );

    const pids = project.pids();
    assert.equal(pids.length, 2, 'precondition: qa and its own-group task both started');
    assert.equal(res.status, 0, 'a qa the gate had to stop says nothing about the task');
    assert.match(res.stderr, /qa was stopped \(timeout\)/);
    assert.deepEqual(pids.filter(isAlive), [], 'no process from the qa tree may outlive the gate');

    const end = readWaits(logDir).find(({ event }) => event === 'end');
    assert.equal(end.outcome, 'timeout');
    assert.ok(end.orphans >= 1, 'the own-group task had to be reaped individually');
  } finally {
    for (const pid of project.pids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    rmSync(logDir, { recursive: true, force: true });
    project.cleanup();
  }
});

// `detached` means qa no longer dies with the gate, so the gate must pass interrupts on.
test('SIGTERM to the gate stops qa instead of orphaning it', async () => {
  const project = makeHangingProject({ withGrandchild: false });
  const logDir = freshLogDir();

  try {
    const pending = runHookAsync(
      'quality-gates.mjs',
      { tool_name: 'Stop' },
      {
        CLAUDE_HOOK_QA_NESTED: '',
        CLAUDE_PROJECT_DIR: project.dir,
        CLAUDE_HOOK_LOG_DIR: logDir,
        CLAUDE_HOOK_QA_GRACE_MS: '500',
      },
    );

    const until = Date.now() + 10_000;
    while (project.pids().length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    assert.equal(project.pids().length, 1, 'precondition: qa is running');

    pending.child.kill('SIGTERM');
    const res = await pending;

    assert.equal(res.status, 0);
    assert.deepEqual(project.pids().filter(isAlive), [], 'qa must not outlive the gate');
    assert.equal(readWaits(logDir).find(({ event }) => event === 'end')?.outcome, 'interrupted');
  } finally {
    for (const pid of project.pids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    rmSync(logDir, { recursive: true, force: true });
    project.cleanup();
  }
});

// The README's review query is how anyone reads the log; a query that miscounts makes the log lie.
test('the README wait-log query counts outcomes per repo and reports an unmatched start as killed', () => {
  const readme = readFileSync(join(HOOKS_DIR, 'README.md'), 'utf8');
  const block = /<!-- wait-log-query -->\n```sh\n([\s\S]*?)\n```/.exec(readme);
  assert.ok(block, 'precondition: the README carries the query under its marker');
  const program = /jq -s '([\s\S]*)'$/.exec(block[1])?.[1];
  assert.ok(program, 'precondition: the query is a single jq -s program');

  const fixture = [
    { event: 'start', id: '1', repo: 'alpha' },
    { event: 'end', id: '1', outcome: 'ran' },
    { event: 'start', id: '2', repo: 'alpha' },
    { event: 'end', id: '2', outcome: 'skipped' },
    { event: 'start', id: '3', repo: 'alpha' },
    { event: 'start', id: '4', repo: 'beta' },
    { event: 'end', id: '4', outcome: 'timeout' },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n');

  const result = spawnSync('jq', ['-s', program], { input: fixture, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { repo: 'alpha', total: 3, outcomes: { killed: 1, ran: 1, skipped: 1 } },
    { repo: 'beta', total: 1, outcomes: { timeout: 1 } },
  ]);
});

// The window between qa's exit and its pipes closing: a child still holding stdout keeps `close`
// away, and a deadline landing there used to relabel a finished, FAILED qa as stopped and allow it.
test('a qa that fails just before the deadline still blocks', async () => {
  const project = makeScratchProject('node fail-late.mjs');
  const go = join(project.dir, 'go');
  const running = join(project.dir, 'running');
  writeFileSync(
    join(project.dir, 'fail-late.mjs'),
    `
    import { spawn } from 'node:child_process';
    import { existsSync, writeFileSync } from 'node:fs';
    const holder = spawn('sleep', ['10'], { stdio: ['ignore', 'inherit', 'inherit'] });
    holder.unref();
    writeFileSync(${JSON.stringify(running)}, String(holder.pid));
    const poll = setInterval(() => {
      if (!existsSync(${JSON.stringify(go)})) return;
      clearInterval(poll);
      console.log('LATE_QA_FAILED');
      process.exit(1);
    }, 20);
    `,
  );

  try {
    const startedAt = Date.now();
    const pending = runHookAsync(
      'quality-gates.mjs',
      { tool_name: 'Stop' },
      {
        CLAUDE_HOOK_QA_NESTED: '',
        CLAUDE_PROJECT_DIR: project.dir,
        CLAUDE_HOOK_QA_DEADLINE_MS: '4000',
        CLAUDE_HOOK_QA_GRACE_MS: '500',
      },
    );

    while (!existsSync(running) && Date.now() - startedAt < 3000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(running), 'precondition: qa is running well before the deadline');
    // qa exits ~500ms before the deadline; the sleeping child holds the pipes well past it.
    await new Promise((r) => setTimeout(r, Math.max(0, 3500 - (Date.now() - startedAt))));
    writeFileSync(go, '');

    const res = await pending;
    assert.equal(res.status, 2, 'a qa that finished and failed must block, deadline or not');
    assert.match(res.stderr, /LATE_QA_FAILED/);
    assert.doesNotMatch(res.stderr, /qa was stopped/);
  } finally {
    // The pipe holder outlives a correct gate on purpose; it is this test's to clean up.
    try {
      process.kill(Number(readFileSync(running, 'utf8')), 'SIGKILL');
    } catch {}
    project.cleanup();
  }
});
