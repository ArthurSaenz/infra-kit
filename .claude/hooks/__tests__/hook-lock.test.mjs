// The lock is the highest-risk code in the pipeline, so it gets the densest tests — and the steal
// path gets the most of them, because stale-steal is the PRIMARY correctness mechanism while
// `releaseLock` in a `finally` is only a latency optimization. `finally` does not run on SIGKILL,
// and the harness killing a hook at its timeout is routine, so the system has to be correct when
// release is never called.
//
// Every case here is DETERMINISTIC. Staleness is PLANTED on disk rather than raced into existence,
// so there is no sleeping-and-hoping: the interleaving under test is constructed, not waited for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HOOKS_DIR } from './helpers.mjs';
import { acquireLock, holdsLock, releaseLock, trySteal } from '../lock.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

// Throwaway lock dirs live under gitignored `.omc/` so the suite leaves the working tree clean.
function makeLockDir() {
  const dir = join(REPO_ROOT, '.omc', `.tmp-lock-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const cachePath = (dir, name = 'claude-hook.lock') => join(dir, 'node_modules', '.cache', name);

// Write a lock record directly, so the state under test exists before any contender runs.
function plantRecord(dir, record, name = 'claude-hook.lock') {
  const path = cachePath(dir, name);
  mkdirSync(join(dir, 'node_modules', '.cache'), { recursive: true });
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record));
  return path;
}

const readRecord = (path) => JSON.parse(readFileSync(path, 'utf8'));

// Everything the lock leaves in `.cache`, so `.steal.*` debris is visible to assertions rather than
// merely absent from the happy path.
function lockArtifacts(dir) {
  const cacheDir = join(dir, 'node_modules', '.cache');
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir).filter((entry) => entry.startsWith('claude-hook.lock'));
}

// -------------------------------------------------------------------------------- basic mutual exclusion

test('a second acquire at waitMs 0 returns null', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    const first = acquireLock(dir, { waitMs: 0, staleMs: 60_000 });
    assert.ok(first, 'first acquire must succeed');
    assert.equal(acquireLock(dir, { waitMs: 0, staleMs: 60_000 }), null, 'second must be refused');
    assert.ok(holdsLock(first), 'the first holder still owns the record');
  } finally {
    cleanup();
  }
});

test('staleMs is required — the module refuses to carry a default', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    // A shared default is exactly how a value tuned for a 90s call site got applied to a 600s one,
    // where a healthy run would be declared stale and a second full-monorepo turbo run launched on
    // top of the first. The module cannot hold a value that is only correct for one caller.
    assert.throws(() => acquireLock(dir, { waitMs: 0 }), /staleMs is required/);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------------------------------ staleness

// AC10 — the two staleness conditions are asserted SEPARATELY on purpose. A combined test passes
// with either check missing, which is precisely the bug it would be written to catch.

test('a lock whose owner pid is dead is stolen immediately', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    // A pid that has certainly exited: spawn a process and let it finish.
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(dead.status, 0);

    // startedAt is NOW, so age cannot be what makes this stale — only the dead pid can.
    plantRecord(dir, { pid: 999_999, startedAt: Date.now(), nonce: randomUUID() });

    const handle = acquireLock(dir, { waitMs: 0, staleMs: 3_600_000 });
    assert.ok(handle, 'a dead owner must be stolen from even with a huge staleMs');
    assert.ok(holdsLock(handle));
  } finally {
    cleanup();
  }
});

test('a lock older than staleMs is stolen', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    // OUR OWN pid, which is certainly alive, so a liveness check cannot be what makes this stale —
    // only the age can.
    plantRecord(dir, { pid: process.pid, startedAt: Date.now() - 10_000, nonce: randomUUID() });

    const handle = acquireLock(dir, { waitMs: 0, staleMs: 1_000 });
    assert.ok(handle, 'an over-age record must be stolen even though its owner is alive');
    assert.ok(holdsLock(handle));
  } finally {
    cleanup();
  }
});

test('a healthy holder is NOT stolen from', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    const nonce = randomUUID();
    plantRecord(dir, { pid: process.pid, startedAt: Date.now(), nonce });
    assert.equal(acquireLock(dir, { waitMs: 0, staleMs: 3_600_000 }), null);
    assert.equal(readRecord(cachePath(dir)).nonce, nonce, 'the healthy record is untouched');
  } finally {
    cleanup();
  }
});

test('a truncated or garbage record is stolen, not fatal', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    // The state a process that died mid-acquire leaves behind. Throwing here would make the lock
    // permanently unacquirable, which fails in the worst direction: every hook silently disabled.
    plantRecord(dir, '{"pid":123,"star');
    const handle = acquireLock(dir, { waitMs: 0, staleMs: 3_600_000 });
    assert.ok(handle, 'an unparseable record must be treated as absent');
    assert.ok(holdsLock(handle));
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------------------------- the steal path

// AC6. Two contenders released against ONE pre-planted stale lock. Deterministic because the
// staleness already exists on disk when both start — nothing is raced into being.
//
// The contenders MUST be launched asynchronously. An earlier version of this test used `spawnSync`
// in a loop, which runs them one after the other — so the first won, exited, and the second
// correctly stole from a now-dead pid. Two winners, no bug: the test had simply never created the
// concurrency it was named for. Overlapping lifetimes are the whole point.
test('exactly one of two concurrent stealers acquires a stale lock', async () => {
  const { dir, cleanup } = makeLockDir();
  try {
    plantRecord(dir, { pid: 999_999, startedAt: Date.now() - 60_000, nonce: randomUUID() });

    // Each child reports only whether it won, then STAYS ALIVE briefly so its pid remains live
    // while its rival is deciding — otherwise the rival's liveness check sees a dead owner and
    // steals legitimately, which is a different scenario from the one under test.
    const script = `
      import { acquireLock, holdsLock } from ${JSON.stringify(join(HOOKS_DIR, 'lock.mjs'))};
      const handle = acquireLock(${JSON.stringify(dir)}, { waitMs: 0, staleMs: 1000 });
      process.stdout.write(handle && holdsLock(handle) ? 'WON' : 'LOST');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    `;

    const run = () =>
      new Promise((resolvePromise) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          encoding: 'utf8',
        });
        let stdout = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.on('close', () => resolvePromise(stdout));
      });

    const results = await Promise.all([run(), run()]);
    const winners = results.filter((stdout) => stdout === 'WON');

    assert.equal(winners.length, 1, `exactly one contender may hold the lock, got ${results.join(',')}`);
  } finally {
    cleanup();
  }
});

// AC7 / M2a — the single most important case in this file. The earlier design UNLINKED on nonce
// mismatch, which removed an innocent holder's record from disk while that holder was mid-pipeline
// and still believed it held the lock. A fresh `wx` then succeeded against the empty path and two
// processes ran `prettier --write` on the same file — the two concurrent writers the lock exists to
// prevent, produced BY the lock.
//
// A NOTE ON WHY THIS USES A SEAM. Two earlier attempts failed to test anything. The first used
// `spawnSync` in a loop, which blocks until the child has fully EXITED — so the "mid-flight" swap
// ran with no other process alive and the assertion merely re-checked that `writeFileSync` works;
// it passed against the retired `unlink` implementation and against a `trySteal` that did nothing.
// The second polled for the record going absent, which is not an invariant of the CORRECT
// implementation either: restore-on-mismatch legitimately leaves the path empty for the two
// syscalls between the rename and the restore, so that test would have failed at random.
//
// The seam removes the guessing. `onClaimed` fires exactly where a healthy holder's acquire lands
// in the real interleaving, so the mismatch branch is entered deterministically, every run.
test('a steal that finds a fresh record restores it instead of unlinking', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    const staleNonce = randomUUID();
    const lockPath = plantRecord(dir, { pid: 999_999, startedAt: Date.now() - 60_000, nonce: staleNonce });

    // The innocent holder: healthy, live pid, and — crucially — NOT the record the stealer judged
    // stale. In the real race it acquired between the stealer's read and the stealer's rename.
    const healthyNonce = randomUUID();
    const healthyRecord = JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce: healthyNonce });

    let claimObserved = null;
    const stole = trySteal(lockPath, 1_000, {
      onClaimed: (claimPath) => {
        claimObserved = claimPath;
        writeFileSync(claimPath, healthyRecord);
      },
    });

    assert.ok(claimObserved, 'precondition: the steal must have reached the claim stage');

    // THE ASSERTION THAT MATTERS. Under the retired `unlink`, the innocent record is gone from disk
    // while its owner is mid-pipeline still believing it holds — a fresh `wx` then succeeds against
    // the empty path and two processes run `prettier --write` on one file. That is the two-writer
    // window the lock exists to prevent, produced BY the lock.
    assert.ok(existsSync(lockPath), "the innocent holder's record must be back ON DISK");
    assert.equal(readRecord(lockPath).nonce, healthyNonce, 'and must be THEIR record, not the stale one');

    // Restoring means the stealer did not take ownership; it must go round again.
    assert.equal(stole, true, 'the caller is told to restart the acquire loop');
    assert.ok(!existsSync(claimObserved), 'and the claim file is not left behind');
  } finally {
    cleanup();
  }
});

// AC8 / M2c. With the OBSERVED nonce, two stealers reading the same stale record rename to the same
// target; POSIX rename-over-existing succeeds silently and BOTH believe they won. Naming the claim
// by the stealer's own fresh nonce is what makes the two renames collide on the SOURCE instead —
// where exactly one can succeed.
// The discriminator is a DECOY. We plant a stale record with a known nonce and pre-create a file at
// the claim path the buggy implementation would choose — `<lock>.steal.<OBSERVED nonce>`. If the
// steal names its claim after the record it observed, its `renameSync` overwrites the decoy and the
// sentinel content is destroyed. If it names the claim after its OWN fresh nonce, the decoy is
// untouched. That is the exact difference between two stealers colliding on one target (POSIX
// rename-over-existing succeeds silently, so BOTH win) and colliding on the source, where exactly
// one rename can succeed.
test('two stealers produce distinct claim paths', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    const observedNonce = 'observed-nonce-fixture';
    const lockPath = plantRecord(dir, {
      pid: 999_999,
      startedAt: Date.now() - 60_000,
      nonce: observedNonce,
    });

    const decoy = `${lockPath}.steal.${observedNonce}`;
    writeFileSync(decoy, 'SENTINEL');

    const handle = acquireLock(dir, { waitMs: 0, staleMs: 1_000 });
    assert.ok(handle, 'the stale record must still be stolen');

    assert.ok(existsSync(decoy), 'the observed-nonce claim path must never be the one used');
    assert.equal(readFileSync(decoy, 'utf8'), 'SENTINEL', 'the decoy must be byte-identical');

    rmSync(decoy, { force: true });
    releaseLock(handle);
  } finally {
    cleanup();
  }
});

// AC9. `.steal.*` claims are unlinked on EVERY path, success included, so `node_modules/.cache/`
// does not silently accumulate debris across thousands of edits.
test('no claude-hook.lock* remains after a normal run, including .steal.* debris', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    const clean = acquireLock(dir, { waitMs: 0, staleMs: 60_000 });
    releaseLock(clean);
    assert.deepEqual(lockArtifacts(dir), [], 'clean acquire/release leaves nothing');

    // And after a steal, which is the path that creates a claim file in the first place.
    plantRecord(dir, { pid: 999_999, startedAt: Date.now() - 60_000, nonce: randomUUID() });
    const stolen = acquireLock(dir, { waitMs: 0, staleMs: 1_000 });
    assert.ok(stolen);
    releaseLock(stolen);
    assert.deepEqual(lockArtifacts(dir), [], 'a steal leaves no .steal.* claim behind');
  } finally {
    cleanup();
  }
});

// AC11d / M-4. The residual window, stated rather than papered over: a stealer moves a live record
// off the path (syscall 1), a third process wins `wx` against the momentarily-empty path, and the
// stealer restores the original over it (syscall 2). The third process's record is now GONE from
// disk — so the check immediately after acquire is what makes it abort BEFORE writing anything.
// Deferring that check to the first write stage leaves it free to act on a lock it no longer owns.
test('a third acquirer in the restore window fails holdsLock before writing', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    const path = cachePath(dir);
    const thirdHandle = acquireLock(dir, { waitMs: 0, staleMs: 60_000 });
    assert.ok(thirdHandle, 'the third acquirer wins wx against an empty path');
    assert.ok(holdsLock(thirdHandle), 'and believes it holds, correctly, for now');

    // Simulate the stealer's restore landing on top of it.
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce: randomUUID() }));

    assert.equal(holdsLock(thirdHandle), false, 'the clobbered acquirer must detect the loss');
    // And it must not delete the restored holder's record on its way out.
    releaseLock(thirdHandle);
    assert.ok(existsSync(path), 'release must not remove a record that is no longer ours');
  } finally {
    cleanup();
  }
});

// AC11c / M-2. `node_modules/.cache` does not exist at the repo root, and on a fresh clone
// `node_modules/` itself may be absent — so `openSync(path,'wx')` throws ENOENT, not EEXIST.
test('acquire succeeds when node_modules/.cache does not exist', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    assert.ok(!existsSync(join(dir, 'node_modules')), 'precondition: no node_modules at all');
    const handle = acquireLock(dir, { waitMs: 0, staleMs: 60_000 });
    assert.ok(handle, 'the cache dir must be created before the first open');
    assert.ok(holdsLock(handle));
  } finally {
    cleanup();
  }
});

// The other half of M-2, and the reason it matters: folding ENOENT into the EEXIST retry loop
// yields a PERMANENT null — the repo-root lock could never be acquired, and the quality gate would
// silently lose its own guard while appearing to work. Only EEXIST may retry; every other fs error
// must propagate as the bug it is.
test('a non-EEXIST fs error propagates and is never treated as a retry condition', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    // A FILE where the `node_modules` directory belongs, so the mkdir that precedes the first open
    // fails. Note this raises ENOTDIR, not ENOENT — the earlier version of this test claimed to
    // exercise ENOENT and did not, because mkdirSync throws before openSync is ever reached. The
    // property under test is the one that actually matters either way: acquire THROWS rather than
    // quietly returning null, so a broken path can never masquerade as a busy lock.
    writeFileSync(join(dir, 'node_modules'), 'not a directory');
    assert.throws(
      () => acquireLock(dir, { waitMs: 0, staleMs: 60_000 }),
      (err) => {
        assert.equal(err.code, 'ENOTDIR', 'the real fs error surfaces unchanged');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

// And the ENOENT condition proper, at the open rather than the mkdir: the lock path itself is a
// DIRECTORY, so `openSync(..., 'wx')` cannot create a file there. It must not be swallowed as a
// retry, which would spin to MAX_ATTEMPTS and return a null indistinguishable from "someone else
// holds it".
test('ENOENT-class open failures are not swallowed as EEXIST', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    mkdirSync(join(dir, 'node_modules', '.cache', 'claude-hook.lock'), { recursive: true });
    assert.throws(
      () => acquireLock(dir, { waitMs: 0, staleMs: 60_000 }),
      (err) => {
        assert.ok(err.code && err.code !== 'EEXIST', `a real fs error, got ${err.code}`);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------------------ write safety

// AC5. Losing the lock means skipping EVERYTHING — including prettier. Prettier is a whole-file
// writer, and running it unlocked is the concurrent-truncation case itself: two whole-file rewrites
// interleaving on one path can revert or truncate each other, which loses the user's source. A
// missed format is free to recover from; a truncated source file is not. So the bytes must come
// through a contended edit completely untouched.
test('the pipeline skips all stages while the lock is held externally', () => {
  const pkgDir = join(REPO_ROOT, '.omc', '.tmp-writesafety-test');
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });

  try {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'tmp-ws', version: '0.0.0' }));
    writeFileSync(
      join(pkgDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
    );

    // Deliberately BOTH badly formatted (so prettier would certainly rewrite it) and type-broken
    // (so tsc would certainly report). Neither may happen while the lock is held elsewhere.
    const original = 'export const    x:number   =   "not a number"\n';
    const file = join(pkgDir, 'src.ts');
    writeFileSync(file, original);

    const held = acquireLock(pkgDir, { waitMs: 0, staleMs: 120_000 });
    assert.ok(held, 'precondition: the test holds the package lock');

    try {
      const res = spawnSync('node', [join(HOOKS_DIR, 'edit-pipeline.mjs')], {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }),
        encoding: 'utf8',
        // A short wait so the test does not sit through the real 2s budget.
        env: { ...process.env, CLAUDE_HOOK_LOCK_WAIT_MS: '200' },
      });

      assert.equal(res.status, 0, 'a contended edit degrades to silence, it does not fail the edit');
      assert.equal(res.stdout + res.stderr, '', 'and reports nothing it could not verify');
      assert.equal(readFileSync(file, 'utf8'), original, 'THE BYTES MUST BE UNTOUCHED');
    } finally {
      releaseLock(held);
    }
  } finally {
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------------- call-site invariants

// AC11 (C1). The invariant is PER ACQUISITION SITE, not global: for every call site,
// staleMs > that site's harness timeout > that site's stage budget. An earlier version of this
// check quantified over CONSTANTS and passed while the 600s quality-gate site sat on a 120s
// staleMs — a healthy cold-cache qa run would have been declared stale at t=120s and a second
// concurrent full-monorepo turbo run launched. This version enumerates the CALL SITES, so it fails
// on that shape.
test('every acquireLock call site has staleMs above its own harness timeout', () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));

  // Map each hook file to the harness timeout settings.json actually grants it, so the two can
  // never drift apart silently.
  const timeouts = new Map();
  for (const group of Object.values(settings.hooks).flat()) {
    for (const hook of group.hooks ?? []) {
      const match = /hooks\/([\w-]+\.mjs)/.exec(hook.command ?? '');
      if (match) timeouts.set(match[1], hook.timeout);
    }
  }

  // DISCOVERED, never hardcoded. A fixed file list reproduces the exact blindness this check was
  // written to end: a third hook could start calling acquireLock with a wrong staleMs, never be
  // enumerated, and the assertion would pass over it in silence — the same failure as quantifying
  // over constants, moved up one level. `lock.mjs` itself is excluded as the definition site.
  // Each call site is located first, then its `staleMs` is read from a bounded window after it. An
  // earlier version used `acquireLock\([^)]*staleMs:` — which stops at the FIRST `)`, so a call
  // like `acquireLock(findPackageDir(f), { staleMs: … })` was invisible and the check passed over
  // it. That is the same blindness this test exists to end, one level further down; it was caught
  // by probing with a deliberately-added third call site, not by reading the regex.
  const sites = [];
  // Recursive: `guards/` holds hooks too, and this check has now been scoped too narrowly twice —
  // first quantifying over constants instead of call sites, then missing a site whose first
  // argument contained a `)`. A future guard calling acquireLock must not be the third instance.
  //
  // `__tests__` is excluded because it lives UNDER the hooks dir: recursing into it collects this
  // file's own fixture calls, which deliberately omit staleMs to prove the check fails on them.
  // Scanning them would make the suite assert against its own scaffolding.
  const sources = readdirSync(HOOKS_DIR, { recursive: true }).filter(
    (name) => name.endsWith('.mjs') && !name.includes('__tests__'),
  );

  for (const file of sources) {
    if (file === 'lock.mjs') continue;
    const source = readFileSync(join(HOOKS_DIR, file), 'utf8');

    for (const call of source.matchAll(/\bacquireLock\(/g)) {
      const window = source.slice(call.index, call.index + 400);
      const staleMs = /staleMs:\s*([\d_]+)/.exec(window);
      // A call site with no literal staleMs is a finding in itself: the module requires the
      // parameter, so such a site throws at runtime and must never pass silently here.
      assert.ok(staleMs, `${file}: an acquireLock call site declares no literal staleMs`);
      sites.push({ file, staleMs: Number(staleMs[1].replaceAll('_', '')) });
    }
  }

  // A tripwire, not a bound: adding a call site must be a conscious act that updates this number
  // and confirms the new site's own budget, rather than silently joining an unchecked crowd.
  assert.equal(sites.length, 2, `expected 2 known call sites, found ${sites.map((s) => s.file).join(', ')}`);

  for (const site of sites) {
    const harnessTimeout = timeouts.get(site.file);
    assert.ok(harnessTimeout, `${site.file} must declare a harness timeout in settings.json`);
    assert.ok(
      site.staleMs > harnessTimeout * 1000,
      `${site.file}: staleMs ${site.staleMs}ms must exceed its OWN harness timeout ${harnessTimeout}s`,
    );
  }
});

// AC11b / M-1. `findPackageDir` returns the repo root for root-level files, so editing
// `.claude/hooks/*.mjs` makes the edit pipeline hold a lock AT THE REPO ROOT. If the quality gate
// shared that filename, its `waitMs: 0` would turn a 1-10s prettier stage into a refused task
// completion reading "another quality gate is already running" — false, and misleading about which
// subsystem was busy.
test('the pipeline lock and the qa lock are different files', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    const pipeline = acquireLock(dir, { waitMs: 0, staleMs: 120_000 });
    assert.ok(pipeline, 'pipeline takes the default-named lock');

    const qa = acquireLock(dir, { name: 'claude-qa.lock', waitMs: 0, staleMs: 900_000 });
    assert.ok(qa, 'the qa lock must be independent, not blocked by the pipeline lock');
    assert.notEqual(pipeline.lockPath, qa.lockPath);

    releaseLock(pipeline);
    releaseLock(qa);
  } finally {
    cleanup();
  }
});
