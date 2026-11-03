#!/usr/bin/env node
// TaskCompleted gate: runs `pnpm run qa` and blocks completion (exit 2) if it fails. The message
// carries the tail of qa's own output — turbo runs with `--output-logs=errors-only`, so that is
// already just the failing checks.

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readInput, block, allow } from './hooklib.mjs';
import { acquireLock, appendWaitRecord, envInt, releaseLock } from './lock.mjs';

const TAIL_CHARS = 4000;
// Full-monorepo output runs to megabytes; only the tail is ever reported.
const KEEP_CHARS = 1024 * 1024;

// The harness SIGKILLs this hook at its `timeout` (settings.json, TaskCompleted: 600s). A SIGKILL
// runs no `finally` and leaves qa's detached group running, so the gate stops qa itself first:
// SIGINT at the deadline, SIGKILL after GRACE, then MARGIN to log and exit. The deadline counts
// from hook start, so lock waits are already paid for, and it only fires where the harness would
// have killed anyway — a qa that finishes today still finishes.
const HARNESS_MS = 600_000;
const MARGIN_MS = 20_000;
const GRACE_MS = 10_000;
const QA_DEADLINE_MS = HARNESS_MS - MARGIN_MS - GRACE_MS;

const sleep = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms));

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

const signal = (pid, name) => {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
};

// Turbo puts each task in its own process group, so signalling qa's group never reaches them, and
// once turbo dies they are reparented to pid 1 and unreachable by ppid. Snapshot the tree BEFORE
// the first signal, while every task still hangs off qa.
const descendantsOf = (rootPid) => {
  let table;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }

  const children = new Map();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }

  const found = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
};

const waitUntilDead = async (pids, ms) => {
  const until = Date.now() + ms;
  while (pids.some(isAlive) && Date.now() < until) await sleep(100);
};

// Returns how many processes outlived the group signals and had to be reaped one by one.
const stopTree = async (leaderPid, firstSignal) => {
  const tree = [leaderPid, ...descendantsOf(leaderPid)];
  const grace = Math.max(envInt('CLAUDE_HOOK_QA_GRACE_MS', GRACE_MS), 100);

  signal(-leaderPid, firstSignal);
  await waitUntilDead(tree, grace);
  signal(-leaderPid, 'SIGKILL');
  // Group members still dying from that SIGKILL answer kill(pid, 0) for a moment; counting them
  // would inflate the orphan figure the log review reads.
  await waitUntilDead(tree, 300);

  const orphans = tree.filter(isAlive);
  for (const pid of orphans) signal(pid, 'SIGTERM');
  await waitUntilDead(orphans, 1000);
  for (const pid of orphans.filter(isAlive)) signal(pid, 'SIGKILL');

  return orphans.length;
};

// `detached` gives qa its own process group, so one signal reaches pnpm, turbo and the shell chain.
// The price is that qa no longer dies with this hook, which is why SIGTERM/SIGINT/SIGHUP sent here
// are forwarded rather than left to their default.
const runQa = (cwd) =>
  new Promise((resolve_) => {
    const child = spawn('pnpm', ['run', 'qa'], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Marks the descent for the gates `test:claude` (run by qa) spawns. See the guard in main().
      env: { ...process.env, CLAUDE_HOOK_QA_NESTED: '1' },
    });

    let output = '';
    const collect = (chunk) => {
      output += chunk;
      if (output.length > 2 * KEEP_CHARS) output = output.slice(-KEEP_CHARS);
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);

    // First reason wins: a SIGTERM arriving while the deadline is already reaping changes nothing.
    // Once qa has exited its status is the verdict: a stop arriving while the pipes drain must not
    // relabel a finished, failed qa as stopped and let it through.
    let exited = false;
    let stopping = null;
    let reaping = null;
    const stop = (reason, firstSignal) => {
      if (reaping || exited) return;
      stopping = reason;
      reaping = stopTree(child.pid, firstSignal);
    };

    // CLAUDE_HOOK_QA_DEADLINE_MS / CLAUDE_HOOK_QA_GRACE_MS are TEST SEAMS only, so the suite can
    // reach the stop path in seconds. Values under 1s are ignored: a near-zero deadline would stop
    // every qa and allow, which is a kill switch, not a seam.
    const deadline = Math.max(envInt('CLAUDE_HOOK_QA_DEADLINE_MS', QA_DEADLINE_MS), 1000);
    const timer = setTimeout(() => stop('timeout', 'SIGINT'), Math.max(0, deadline - performance.now()));
    const forwarded = ['SIGTERM', 'SIGINT', 'SIGHUP'].map((name) => {
      const handler = () => stop('interrupted', name);
      process.on(name, handler);
      return [name, handler];
    });

    const finish = (status, orphans, error) => {
      clearTimeout(timer);
      for (const [name, handler] of forwarded) process.off(name, handler);
      resolve_({ status, output: error ? `${output}${error.message}` : output, stopping, orphans });
    };

    child.on('error', (error) => finish(null, 0, error));
    // `exit`, not `close`: turbo's tasks inherit the pipes, and an orphan holding them would keep
    // `close` from ever firing. Give buffered output a moment, then let go of the pipes.
    child.on('exit', async (status) => {
      exited = true;
      clearTimeout(timer);
      const closed = new Promise((done) => child.once('close', done));
      await Promise.race([closed, sleep(1000)]);
      child.stdout.destroy();
      child.stderr.destroy();
      // qa can exit on the first SIGINT while its tasks are still being reaped.
      finish(status, reaping ? await reaping : 0);
    });
  });

const repoName = (cwd) => {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return basename(dirname(resolve(common.trim())));
  } catch {
    return basename(cwd);
  }
};

const main = async () => {
  // SELF-DESCENT GUARD, before anything else so there is no lock to unwind. `qa` runs the `.claude`
  // suite (`test:claude`), which spawns this hook again; without the guard that inner gate would
  // queue behind its own grandparent's lock. Lock serialises peers; this stops recursion.
  if (process.env.CLAUDE_HOOK_QA_NESTED) allow();

  let input;
  try {
    input = readInput();
  } catch {
    input = { taskSubject: '' };
  }

  const cwd = process.env.CLAUDE_PROJECT_DIR;
  if (!cwd) block('quality-gates: CLAUDE_PROJECT_DIR not set — cannot run QA, failing closed.');

  // Every subagent completion fires a full-monorepo turbo run, contending on the turbo cache.
  // `name` is NOT the pipeline's lock, which it also holds at the repo root on root-level edits.
  // `staleMs` sits above this site's 600s harness timeout.
  //
  // QUEUE, then pass — never refuse. On timeout we ALLOW: the next completion re-runs qa across the
  // whole monorepo, so a skipped run costs far less than a task that cannot finish. Tests override
  // the wait via CLAUDE_HOOK_LOCK_WAIT_MS. Why refusing was wrong — see README Design notes.
  const lock = acquireLock(cwd, { name: 'claude-qa.lock', waitMs: 60_000, staleMs: 900_000 });

  const id = randomUUID();
  appendWaitRecord({
    event: 'start',
    id,
    repo: repoName(cwd),
    cwd,
    waitedMs: Math.round(performance.now()),
    lock: Boolean(lock),
  });

  if (!lock) {
    appendWaitRecord({ event: 'end', id, outcome: 'skipped' });
    process.stderr.write(
      'quality-gates: another gate held the lock for the whole wait; skipping this run. ' +
        'The next task completion re-runs qa over the whole monorepo.\n',
    );
    allow();
  }

  const ranFrom = performance.now();
  let result;
  try {
    result = await runQa(cwd);
  } finally {
    releaseLock(lock);
  }

  const outcome = result.stopping ?? (result.status === 0 ? 'ran' : 'failed');
  appendWaitRecord({
    event: 'end',
    id,
    outcome,
    ranMs: Math.round(performance.now() - ranFrom),
    exit: result.status,
    orphans: result.orphans,
  });

  // Same reasoning as the skip above: a qa the gate had to stop says nothing about the task.
  if (result.stopping) {
    process.stderr.write(`quality-gates: qa was stopped (${outcome}) before it finished; not blocking.\n`);
    allow();
  }

  if (result.status === 0) allow();

  const output = result.output.trimEnd();

  block(
    [
      `QA failed. Fix before completing: ${input.taskSubject}`,
      '',
      output.slice(-TAIL_CHARS) || '(qa produced no output)',
      '',
      'Re-run in full with: pnpm run qa',
    ].join('\n'),
  );
};

main();
