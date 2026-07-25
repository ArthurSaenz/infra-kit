// Advisory file lock for hooks that must not run concurrently with themselves.
// Node stdlib only, so a hook can never be broken by a dependency.
//
// The resource being protected is per-package: the incremental tsbuildinfo under
// `<pkgDir>/node_modules/.cache/`, and the source files that `prettier --write` / `eslint --fix`
// rewrite WHOLE. Whole-file rewrites are not patches — two of them interleaving on one path can
// revert or truncate the other, which loses the user's source. That, not untidiness, is why this
// module exists at all. CLAUDE.md mandates subagent delegation, so several agents editing one tree
// concurrently is the DESIGNED operating mode, not an exotic case.
//
// STALE-STEAL IS THE PRIMARY CORRECTNESS MECHANISM; `releaseLock` in a `finally` is only a latency
// optimization. `finally` does not run on SIGKILL, and the harness killing a hook at its timeout is
// a routine event, not a crash. The system therefore has to be correct when `releaseLock` is NEVER
// called — every design choice below follows from that.

import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Dependency-free synchronous sleep. `Atomics.wait` on a SharedArrayBuffer blocks the thread
// without burning CPU; there is no stdlib sync sleep and a spin loop would fight the very tool
// processes we are waiting on for the same core.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// A record that cannot be read or cannot be understood is treated as ABSENT, not as fatal. A
// half-written or truncated record means the writer died mid-acquire, which is exactly the state
// the steal path exists to clear.
function readRecord(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof record?.nonce !== 'string') return null;
    return record;
  } catch {
    return null;
  }
}

// Stale iff the owner is provably gone OR it has held longer than the caller's budget allows.
// `process.kill(pid, 0)` sends no signal; it only asks whether the pid is signalable. ESRCH means
// no such process (steal). EPERM means the process exists but belongs to another user — alive, so
// NOT stale. Treating EPERM as stale would steal from a healthy holder.
function isStale(record, staleMs) {
  if (!record || typeof record.pid !== 'number' || typeof record.startedAt !== 'number') return true;
  if (Date.now() - record.startedAt > staleMs) return true;

  try {
    process.kill(record.pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return true;
  }

  return false;
}

// Attempt to displace an apparently-stale holder. Returns true when the caller should RESTART the
// acquire loop — which covers both "we cleared the path" and "we put an innocent record back and
// must re-evaluate". Returns false when the holder is healthy and the caller should wait.
//
// Every one of the four rules below fixes a specific way an earlier design produced the two
// concurrent writers it claimed to prevent.
//
// `onClaimed` is a TEST SEAM, and it exists because the branch below is otherwise untestable. The
// mismatch case requires a healthy holder to acquire in the window between the staleness read and
// the rename — genuine concurrency, at a two-syscall granularity. It cannot be reproduced by racing
// real processes (an earlier attempt to do so produced a test that asserted nothing at all), and it
// cannot be reproduced single-threaded, because a rename moves a directory entry and the claim
// therefore reads back byte-identical to what was on the path. The callback fires after the rename
// and before the read, which is exactly where the real interleaving lands. It defaults to undefined
// and costs production nothing.
export function trySteal(lockPath, staleMs, { onClaimed } = {}) {
  const observedBefore = readRecord(lockPath);
  if (!isStale(observedBefore, staleMs)) return false;

  // (1) The claim path is named by the STEALER'S OWN fresh nonce, never the observed record's.
  // With the observed nonce, two stealers that read the same stale record rename to the SAME
  // target; POSIX rename-over-existing succeeds silently, and BOTH believe they won.
  const claim = `${lockPath}.steal.${randomUUID()}`;

  try {
    renameSync(lockPath, claim);
  } catch (err) {
    // Another contender moved it first. Exactly one rename can succeed, so this one lost; restart
    // and let the normal `wx` path decide the winner.
    if (err.code === 'ENOENT') return true;
    throw err;
  }

  let restored = false;

  try {
    onClaimed?.(claim);
    const observedAfter = readRecord(claim);

    // (2) RESTORE, never unlink. If a healthy holder acquired in the gap between our staleness
    // read and our rename, the record we just moved off the path is THEIRS and they are mid-
    // pipeline believing they hold it. Unlinking here is what opened a multi-second two-writer
    // window in the earlier design: the innocent holder kept running while a fresh `wx` succeeded
    // against the now-empty path.
    //
    // `?.nonce` on both sides is deliberate: a garbage record reads as null on both sides and
    // compares equal, so an unparseable record is stolen rather than restored forever.
    if (observedAfter?.nonce !== observedBefore?.nonce) {
      renameSync(claim, lockPath);
      restored = true;
    }

    return true;
  } finally {
    // (4) Claim files are unlinked on EVERY path, success included, so `node_modules/.cache/` does
    // not silently accumulate `.steal.*` debris. On the restore path the rename already moved it.
    if (!restored) rmSync(claim, { force: true });
  }
}

// The loop is bounded even though the only unbounded shape is a livelock (steal succeeds, a third
// party wins the `wx`, repeat). "No unbounded wait" is a guardrail of this design, so the bound is
// explicit rather than argued away.
const MAX_ATTEMPTS = 100;

/**
 * Acquire the lock at `<dir>/node_modules/.cache/<name>`.
 *
 * `staleMs` is REQUIRED and has NO default, on purpose. Its correct value is a property of the
 * CALLER's harness timeout, not of this module: the invariant is
 *   staleMs > that call site's harness timeout > that call site's stage budget
 * so a healthy holder can never be declared stale, and the harness timeout is never the mechanism
 * doing the enforcing. A shared default is precisely how a value tuned for a 90s site got applied
 * to a 600s site, where a perfectly healthy run would be declared stale and a SECOND full-monorepo
 * turbo run launched on top of the first. A module-level default cannot be correct for two callers
 * with different budgets, so this module refuses to carry one.
 *
 * `name` is likewise explicit, because `findPackageDir` returns the repo root for root-level files
 * — so editing `.claude/hooks/*.mjs` makes the edit pipeline hold a lock at the REPO ROOT. If the
 * quality gate shared that filename, a 1-10s prettier stage would make task completion refuse with
 * "another quality gate is already running", which is both false and misleading.
 *
 * @returns a handle, or null if the lock could not be taken within `waitMs`.
 */
export function acquireLock(dir, { name = 'claude-hook.lock', waitMs = 2000, staleMs } = {}) {
  if (typeof staleMs !== 'number' || !Number.isFinite(staleMs)) {
    throw new TypeError('acquireLock: staleMs is required — see the per-call-site invariant.');
  }

  const effectiveWaitMs = envInt('CLAUDE_HOOK_LOCK_WAIT_MS', waitMs);
  const effectiveStaleMs = envInt('CLAUDE_HOOK_LOCK_STALE_MS', staleMs);
  const lockPath = join(dir, 'node_modules', '.cache', name);

  // mkdir BEFORE the first openSync. `node_modules/.cache` does not exist at the repo root, and on
  // a fresh clone `node_modules/` itself may be absent — so `openSync(path, 'wx')` would throw
  // ENOENT, not EEXIST. Folding ENOENT into the EEXIST retry below would yield a permanent null:
  // the repo-root lock could never be acquired and the quality gate would silently lose its own
  // guard while appearing to work. ENOENT on acquire is a BUG, never a retry condition, and is
  // deliberately left to propagate.
  mkdirSync(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + effectiveWaitMs;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const nonce = randomUUID();
    let fd;

    try {
      // 'wx' is create-or-fail, atomic against a concurrent creator at the syscall level. This,
      // not the record contents, is what makes exactly one process the winner.
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // (3) After a successful steal the winner does NOT write into the claim path and does NOT
      // rename its way in. It comes back through this same `wx`, and an EEXIST here simply
      // restarts the loop — because a third process may have acquired cleanly in the gap, and
      // rename-then-write would clobber it silently.
      if (trySteal(lockPath, effectiveStaleMs)) continue;
      // NOTE: the deadline is only consulted when the steal path declines, so `waitMs: 0` is "wait
      // for nobody", not "attempt exactly once" — a caller that keeps finding stealable records can
      // loop past its deadline without ever sleeping. MAX_ATTEMPTS, not this deadline, is what
      // bounds that path, so the guarantee is termination and latency rather than a hang.
      if (Date.now() >= deadline) return null;
      sleepSync(50);
      continue;
    }

    try {
      // The NONCE is the identity, not the pid. Pids recycle, and a recycled pid would make a dead
      // holder's record look alive to `process.kill(pid, 0)` forever.
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce }));
    } finally {
      closeSync(fd);
    }

    return { lockPath, nonce };
  }

  return null;
}

// True iff the record on disk is still OURS.
//
// This MUST be called immediately after a successful acquire, BEFORE the first stage — not merely
// "before each write stage". There is a two-syscall window in which a stealer moves a live record
// off the path, a third process wins `wx` against the momentarily-empty path, and the stealer then
// restores the original record over it. After that restore the third process's record is GONE from
// disk, so this check is what makes it abort before writing anything. Deferring the first check to
// the first write stage leaves that process free to act on a lock it no longer owns.
//
// Its limits, stated exactly: it CLOSES that two-syscall restore window completely, and it only
// NARROWS the general window, because it is an instantaneous read taken immediately before a
// multi-second `spawnSync` and the dangerous interval is the spawn itself. It is a mitigation, not
// a proof.
export function holdsLock(handle) {
  if (!handle) return false;
  return readRecord(handle.lockPath)?.nonce === handle.nonce;
}

// Unlink only if the record is still ours, so a process that already lost the lock to a steal
// cannot delete the current holder's record on its way out.
export function releaseLock(handle) {
  if (!holdsLock(handle)) return;
  rmSync(handle.lockPath, { force: true });
}
