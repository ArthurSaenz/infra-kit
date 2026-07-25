#!/usr/bin/env node
// TaskCompleted gate: runs `pnpm run qa` and blocks completion (exit 2) if it fails.
//
// This is now the SOLE test signal. The per-edit `run-tests-async.mjs` was deleted along with the
// two races it owned (an intra-event torn read, and a report that arrived a turn late describing
// bytes that no longer existed), so a broken test surfaces here rather than at edit time. That
// trade is only acceptable if this hook says WHAT failed — the old version ran qa with
// `stdio: 'inherit'` and emitted one generic sentence, so the agent learned that qa failed and
// never which check, which package, or why.

import { spawnSync } from 'node:child_process';
import { readInput, block, allow } from './hooklib.mjs';
import { acquireLock, releaseLock } from './lock.mjs';

// Turbo's per-line log prefix. PINNED in the root `qa` script via `--log-prefix=task`, because the
// default `auto` is TTY-DEPENDENT — and capturing output below is precisely what removes the TTY.
// Leaving the only parse contract resting on an unpinned default would be a dependency on
// undocumented behavior.
const RE_TURBO_LOG_LINE = /^([^\s:]+):([^\s:]+): ?(.*)$/;
// Turbo's end-of-run summary, the authoritative list. `--continue` means a failing run routinely
// produces SEVERAL pairs, so this is parsed as a list and never as "the failing pair".
const RE_TURBO_FAILED_SUMMARY = /^Failed:\s+(.+)$/m;

const MAX_REPORTED = 3;
const TAIL_CHARS = 700;

/**
 * Extract every failing `<pkg>:<task>` from a captured `pnpm run qa` run, each with a tail of its
 * own log lines and the command that reproduces it.
 *
 * `test:hooks` gets its own branch because it is chained with `&&` OUTSIDE turbo, so its failure
 * carries no `<pkg>:<task>:` prefix and this parser cannot name it. Without the branch, the hook
 * test suite — the safety net for this very pipeline — would be the one failure the reporter could
 * not identify. Making it a turbo task instead would mean inventing a root package for it to be a
 * task of, purely to satisfy a log parser; the `&&` chain is the honest structure and this is its
 * cost, paid explicitly.
 */
export function parseQaFailures(output) {
  const summary = RE_TURBO_FAILED_SUMMARY.exec(output);

  if (summary) {
    const pairs = summary[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [pkg, task] = entry.split('#');
        return { pkg, task };
      })
      .filter((pair) => pair.pkg && pair.task);

    if (pairs.length > 0) {
      // Group the prefixed lines once, rather than re-scanning the whole capture per pair.
      const logs = new Map();

      for (const line of output.split('\n')) {
        const match = RE_TURBO_LOG_LINE.exec(line);
        if (!match) continue;
        const key = `${match[1]}#${match[2]}`;
        if (!logs.has(key)) logs.set(key, []);
        logs.get(key).push(match[3]);
      }

      return {
        kind: 'turbo',
        total: pairs.length,
        failures: pairs.slice(0, MAX_REPORTED).map(({ pkg, task }) => ({
          name: `${pkg}#${task}`,
          reproduce: `pnpm --filter ${pkg} run ${task}`,
          tail: (logs.get(`${pkg}#${task}`) ?? []).join('\n').slice(-TAIL_CHARS),
        })),
      };
    }
  }

  // No turbo pairs, but the `&&`-chained hook suite is in the capture => name it explicitly.
  if (/test:hooks/.test(output)) {
    const start = output.lastIndexOf('test:hooks');
    return {
      kind: 'test:hooks',
      total: 1,
      failures: [
        {
          name: 'test:hooks failed',
          reproduce: 'pnpm run test:hooks',
          tail: output.slice(start).slice(-TAIL_CHARS),
        },
      ],
    };
  }

  // qa failed before any check reported — a missing script, a turbo crash, `vendor:check`. "Failed
  // to run at all" and "a check reported problems" are different outcomes and must not be
  // collapsed into one message.
  return { kind: 'unparsed', total: 0, failures: [], tail: output.slice(-TAIL_CHARS) };
}

function main() {
  let input;
  try {
    input = readInput();
  } catch {
    input = { taskSubject: '' };
  }

  const cwd = process.env.CLAUDE_PROJECT_DIR;
  if (!cwd) block('quality-gate: CLAUDE_PROJECT_DIR not set — cannot run QA, failing closed.');

  // Repo-root lock — the concurrency THIS design created. Making the gate load-bearing means every
  // subagent task completion fires a full-monorepo `turbo run` concurrently, contending on the
  // turbo cache, `.eslintcache`, and every package's tsbuildinfo. Locking the 2-second edit path
  // meticulously while leaving the 600-second path unguarded would be incoherent.
  //
  // `name: 'claude-qa.lock'` — a DIFFERENT FILE from the edit pipeline's `claude-hook.lock`, which
  // that pipeline legitimately holds at the repo root whenever a root-level file is edited. Sharing
  // the name would make a 1-10s prettier stage refuse a task completion with a message that is
  // false as well as unhelpful.
  //
  // `staleMs: 900_000` — derived from THIS site's 600s harness timeout, not the pipeline's 90s. A
  // cold-cache qa run is exactly the case the long timeout exists for, and a shorter staleMs would
  // declare that healthy run stale and let a second completion steal the lock and launch a second
  // concurrent full-monorepo turbo run: verbatim the hazard this lock prevents.
  //
  // `waitMs: 0` — refusing is correct for TaskCompleted (it must not pass unverified) and it is
  // cheap. Two subagents finishing in lockstep can ping-pong refusals, which is NOT a deadlock:
  // there is no lock ordering and no nesting, and waitMs 0 means nothing ever waits while holding.
  // Recovery is the agent re-running TaskCompleted, which is why the message says so.
  const lock = acquireLock(cwd, { name: 'claude-qa.lock', waitMs: 0, staleMs: 900_000 });
  if (!lock) block('Another quality gate is already running; re-run when it completes.');

  let result;
  try {
    result = spawnSync('pnpm', ['run', 'qa'], {
      cwd,
      encoding: 'utf8',
      // Explicit, because switching from `stdio: 'inherit'` to a captured pipe buffers into
      // spawnSync's 1MB default, and full-monorepo turbo output exceeds it — yielding ENOBUFS and
      // a truncated capture, mis-parsing the one thing this hook exists to parse. The capture also
      // costs live streaming to the user's terminal: a deliberate trade, since the agent needs the
      // text more than the user needs the stream.
      maxBuffer: 32 * 1024 * 1024,
    });
  } finally {
    releaseLock(lock);
  }

  if (result.status === 0) allow();

  const parsed = parseQaFailures((result.stdout ?? '') + (result.stderr ?? ''));

  if (parsed.kind === 'unparsed') {
    block(
      `QA did not run to completion (no check reported). Fix before completing: ${input.taskSubject}\n\n${parsed.tail}`,
    );
  }

  const blocks = parsed.failures.map(
    (failure) => `${failure.name}  —  reproduce: ${failure.reproduce}\n${failure.tail}`,
  );

  const suppressed =
    parsed.total > parsed.failures.length
      ? `\n\n… ${parsed.total - parsed.failures.length} more failing check(s) not shown.`
      : '';

  block(
    `QA checks failing (${parsed.total}). Fix before completing: ${input.taskSubject}\n\n${blocks.join('\n\n')}${suppressed}`,
  );
}

// Only run when invoked as a hook. The parser above is imported directly by the test suite, which
// must not fire a full monorepo qa run just to assert on a string.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
