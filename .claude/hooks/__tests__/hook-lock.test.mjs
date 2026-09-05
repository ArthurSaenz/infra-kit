// The steal path gets the most coverage, because stale-steal is the lock's PRIMARY correctness
// mechanism. Every case is DETERMINISTIC: staleness is PLANTED on disk, never raced into existence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';

import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HOOKS_DIR } from './helpers.mjs';
import { acquireLock, holdsLock, releaseLock, trySteal } from '../lock.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

// Throwaway lock dirs live under gitignored `.omc/` so the suite leaves the working tree clean.
const makeLockDir = () => {
  const dir = join(REPO_ROOT, '.omc', `.tmp-lock-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const cachePath = (dir, name = 'claude-hook.lock') => join(dir, 'node_modules', '.cache', name);

// Write a lock record directly, so the state under test exists before any contender runs.
const plantRecord = (dir, record, name = 'claude-hook.lock') => {
  const path = cachePath(dir, name);
  mkdirSync(join(dir, 'node_modules', '.cache'), { recursive: true });
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record));
  return path;
};

const readRecord = (path) => JSON.parse(readFileSync(path, 'utf8'));

// So `.steal.*` debris is visible to assertions, not merely absent from the happy path.
const lockArtifacts = (dir) => {
  const cacheDir = join(dir, 'node_modules', '.cache');
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir).filter((entry) => entry.startsWith('claude-hook.lock'));
};

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

// The missing companion to the test above: `waitMs: 0` was pinned, every larger value was not, so
// an attempt cap silently capped every wait (60s asked, 5.4s given, suite green, QA skipped).
// Polling is dialled down so this costs ms — the old ceiling at 1ms polling would be ~100ms.
test('acquireLock waits the full waitMs before giving up — no hidden attempt ceiling', () => {
  const { dir, cleanup } = makeLockDir();
  const previousPoll = process.env.CLAUDE_HOOK_LOCK_POLL_MS;
  const previousWait = process.env.CLAUDE_HOOK_LOCK_WAIT_MS;

  process.env.CLAUDE_HOOK_LOCK_POLL_MS = '1';
  delete process.env.CLAUDE_HOOK_LOCK_WAIT_MS; // an inherited override would defeat the measurement

  try {
    // Live pid, fresh record, huge staleMs: the holder is never stealable, so the contender can
    // only ever leave through the deadline.
    const holder = acquireLock(dir, { waitMs: 0, staleMs: 900_000 });
    assert.ok(holder, 'precondition: the holder must take the lock');

    const startedAt = Date.now();
    const contender = acquireLock(dir, { waitMs: 400, staleMs: 900_000 });
    const waited = Date.now() - startedAt;

    assert.equal(contender, null, 'a healthy holder must not be displaced');
    assert.ok(
      waited >= 400,
      `asked for 400ms, gave up after ${waited}ms — something is capping the wait again`,
    );

    releaseLock(holder);
  } finally {
    if (previousPoll === undefined) delete process.env.CLAUDE_HOOK_LOCK_POLL_MS;
    else process.env.CLAUDE_HOOK_LOCK_POLL_MS = previousPoll;
    if (previousWait !== undefined) process.env.CLAUDE_HOOK_LOCK_WAIT_MS = previousWait;
    cleanup();
  }
});

test('staleMs is required — the module refuses to carry a default', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    // A shared default lets a 90s value reach a 600s site, declaring a healthy run stale.
    assert.throws(() => acquireLock(dir, { waitMs: 0 }), /staleMs is required/);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------------------------------ staleness

// Asserted SEPARATELY: a combined test passes with either check missing — the bug it would exist
// to catch.

test('a lock whose owner pid is dead is stolen immediately', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    // A pid that has certainly exited: spawn a process and let it finish.
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(dead.status, 0);

    // startedAt is NOW, so only the dead pid can make this stale.
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
    // Our OWN pid, certainly alive, so only the age can make this stale.
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
    // What a process that died mid-acquire leaves. Throwing would make the lock permanently
    // unacquirable — every hook silently disabled.
    const path = plantRecord(dir, '{"pid":123,"star');

    // AGED: unreadable only proves a DEAD writer once it is too old to be one still mid-acquire.
    // See writtenWithinGrace in lock.mjs.
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(path, longAgo, longAgo);

    const handle = acquireLock(dir, { waitMs: 0, staleMs: 3_600_000 });
    assert.ok(handle, 'an unparseable record must be treated as absent');
    assert.ok(holdsLock(handle));
  } finally {
    cleanup();
  }
});

// The other half of the case above: `wx` leaves the file EMPTY for one syscall, so every healthy
// acquire is briefly unreadable. That window used to be stolen from — mutual exclusion survived,
// but the victim then skipped its work in silence.
test('a holder caught mid-acquire, before its record is written, is NOT stolen from', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    mkdirSync(join(dir, 'node_modules', '.cache'), { recursive: true });

    // Byte-for-byte the state acquireLock occupies between openSync(wx) and writeFileSync.
    const lockPath = cachePath(dir);
    const fd = openSync(lockPath, 'wx');

    try {
      assert.equal(trySteal(lockPath, 900_000), false, 'a live mid-acquire holder must survive');
      assert.ok(existsSync(lockPath), 'and its lock file must still be at the lock path');
    } finally {
      closeSync(fd);
    }
  } finally {
    cleanup();
  }
});

// The grace can only make a lock HARDER to steal, so anything it gets wrong turns a transient skip
// into a permanent one. These three pin the ways it must still let go.

test('an unreadable record with a FUTURE mtime is still stolen — a clock ahead must not hold the lock', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    const path = plantRecord(dir, '{"pid":123,"star');
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(path, future, future);

    // A negative age also satisfies `< GRACE`, so a one-sided window protects this for the hour.
    const handle = acquireLock(dir, { waitMs: 0, staleMs: 3_600_000 });
    assert.ok(handle, 'a clock an hour ahead must not make the lock un-acquirable');
    releaseLock(handle);
  } finally {
    cleanup();
  }
});

test('a symlink at the lock path is stolen, not mistaken for a holder mid-acquire', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    const cacheDir = join(dir, 'node_modules', '.cache');
    mkdirSync(cacheDir, { recursive: true });
    const target = join(cacheDir, 'target');
    writeFileSync(target, 'fresh');
    symlinkSync(target, cachePath(dir));

    // `stat` follows the link to a fresh file whose mtime can be refreshed forever, so it never
    // self-heals. `lstat` sees the link, fails isFile(), and lets it be stolen on first contact.
    const handle = acquireLock(dir, { waitMs: 0, staleMs: 3_600_000 });
    assert.ok(handle, 'a symlink must not be able to pose as a live mid-acquire holder');
    releaseLock(handle);
  } finally {
    cleanup();
  }
});

test('the grace EXPIRES: a fresh unreadable record becomes acquirable, not never', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    plantRecord(dir, ''); // empty — exactly what `wx` leaves before the record is written

    const startedAt = Date.now();
    const handle = acquireLock(dir, { waitMs: 5_000, staleMs: 3_600_000 });
    const waited = Date.now() - startedAt;

    assert.ok(handle, 'the grace must expire — otherwise it is a permanent lock, not a window');
    assert.ok(waited >= 500, `expected a real wait while the grace held, got ${waited}ms`);
    releaseLock(handle);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------------------------- the steal path

// MUST be launched asynchronously: `spawnSync` in a loop runs them in sequence, so the first wins,
// exits, and the second legitimately steals from a dead pid — two winners, and no concurrency.
test('exactly one of two concurrent stealers acquires a stale lock', async () => {
  const { dir, cleanup } = makeLockDir();
  try {
    plantRecord(dir, { pid: 999_999, startedAt: Date.now() - 60_000, nonce: randomUUID() });

    // Each child STAYS ALIVE briefly, so its rival's liveness check does not see a dead owner and
    // steal legitimately — a different scenario from the one under test.
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

// UNLINKING on nonce mismatch would remove an innocent holder's record mid-pipeline, letting a
// fresh `wx` succeed against the empty path — two writers, produced BY the lock.
//
// It needs the seam: `spawnSync` blocks until the child EXITS, and polling for the record going
// absent is not an invariant either, since restore legitimately empties the path for two syscalls.
test('a steal that finds a fresh record restores it instead of unlinking', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    const staleNonce = randomUUID();
    const lockPath = plantRecord(dir, { pid: 999_999, startedAt: Date.now() - 60_000, nonce: staleNonce });

    // The innocent holder: live pid, and NOT the record the stealer judged stale.
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

    // Under `unlink` this record is gone while its owner is mid-pipeline.
    assert.ok(existsSync(lockPath), "the innocent holder's record must be back ON DISK");
    assert.equal(readRecord(lockPath).nonce, healthyNonce, 'and must be THEIR record, not the stale one');

    // Restoring means the stealer did not take ownership; it must go round again.
    assert.equal(stole, true, 'the caller is told to restart the acquire loop');
    assert.ok(!existsSync(claimObserved), 'and the claim file is not left behind');
  } finally {
    cleanup();
  }
});

// With the OBSERVED nonce two stealers rename to the same target, and POSIX lets BOTH win. The
// DECOY sits at that buggy claim path: naming the claim after the observed record destroys it.
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

// Unlinked on EVERY path, so `.cache/` does not accumulate debris across thousands of edits.
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

// The residual window: a stealer moves a live record off the path, a third process wins `wx`, and
// the stealer restores the original over it — leaving the third process's record gone.
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

// `.cache` does not exist at the repo root, so `wx` throws ENOENT rather than EEXIST.
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

// Folding ENOENT into the EEXIST retry yields a PERMANENT null, and the quality gate would lose its
// guard while appearing to work. Only EEXIST may retry.
test('a non-EEXIST fs error propagates and is never treated as a retry condition', () => {
  const { dir, cleanup } = makeLockDir();
  try {
    // A FILE where `node_modules` belongs, so the mkdir fails first — ENOTDIR, not ENOENT. Either
    // way acquire THROWS rather than returning null, so a broken path cannot look like a busy lock.
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

// The same at the open: the lock path is a DIRECTORY, so `wx` cannot create a file. Swallowed as a
// retry it would spin out the whole waitMs and return a null meaning "someone else holds it".
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

// Losing the lock skips EVERYTHING, prettier included: two whole-file rewrites interleaving on one
// path can truncate each other, so the bytes must survive a contended edit untouched.
//
// The skip must also be AUDIBLE. This test once asserted the opposite — "degrades to silence" —
// which was the defect written down: to the agent, silence reads as a clean check.
test('the pipeline skips all stages while the lock is held externally, and says so', () => {
  const pkgDir = join(REPO_ROOT, '.omc', '.tmp-writesafety-test');
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });

  try {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'tmp-ws', version: '0.0.0' }));
    writeFileSync(
      join(pkgDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
    );

    // Both badly formatted and type-broken, so prettier and tsc would each certainly act.
    const original = 'export const    x:number   =   "not a number"\n';
    const file = join(pkgDir, 'src.ts');
    writeFileSync(file, original);

    const held = acquireLock(pkgDir, { waitMs: 0, staleMs: 120_000 });
    assert.ok(held, 'precondition: the test holds the package lock');

    try {
      const res = spawnSync('node', [join(HOOKS_DIR, 'edit-pipeline.mjs')], {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }),
        encoding: 'utf8',
        // A short wait so the test does not sit through the real 8s budget.
        env: { ...process.env, CLAUDE_HOOK_LOCK_WAIT_MS: '200' },
      });

      assert.equal(res.status, 0, 'a contended edit must not fail the edit, and must not block');
      assert.match(
        res.stdout,
        /SKIPPED/,
        'the skip must announce itself — silence is indistinguishable from a clean check',
      );
      // The CHANNEL, not just the words: stderr is dropped on exit 0, so asserting on it would
      // pass while the agent saw nothing.
      assert.match(
        res.stdout,
        /"hookEventName":\s*"PostToolUse"/,
        'and must ride additionalContext, the exit-0 channel that actually reaches the model',
      );
      assert.equal(readFileSync(file, 'utf8'), original, 'THE BYTES MUST BE UNTOUCHED');
    } finally {
      releaseLock(held);
    }
  } finally {
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------------- call-site invariants

// PER CALL SITE, not global. Quantifying over CONSTANTS instead passes while a 600s site sits on a
// 120s staleMs, so this enumerates the sites.
test('every acquireLock call site has staleMs above its own harness timeout', () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));

  // Read from settings.json, so the two can never drift apart silently.
  const timeouts = new Map();
  for (const group of Object.values(settings.hooks).flat()) {
    for (const hook of group.hooks ?? []) {
      const match = /hooks\/([\w-]+\.mjs)/.exec(hook.command ?? '');
      if (match) timeouts.set(match[1], hook.timeout);
    }
  }

  // DISCOVERED, never hardcoded: a fixed list lets a new hook pass over in silence. The window is
  // bounded by length, not by `)` — `[^)]*staleMs:` would hide `acquireLock(findPackageDir(f), {…})`.
  const sites = [];
  // Recursive, because `guards/` holds hooks too. `__tests__` is excluded: it would collect this
  // file's own fixture calls, which omit staleMs deliberately.
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

// The edit pipeline holds a lock AT THE REPO ROOT when `.claude/hooks/*.mjs` is edited, so a shared
// filename would turn a 1-10s prettier stage into a refused task completion.
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
