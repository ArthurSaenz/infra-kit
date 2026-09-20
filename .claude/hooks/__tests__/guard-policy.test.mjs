// The over-blocking policy, made executable. block-deploy treats a false deny as correct, cmux as
// a defect — holding both with no boundary is what denied `pnpm exec rg deliver src/`.
// I1: over-blocking is fine when the matched string has one purpose, not when it is vocabulary.
// I2: a last-resort catch-all must not be nested in a conditional arm (asserted in block-deploy.test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { HOOKS_DIR } from './helpers.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

// SELF-REFERENCE IS NOT VOCABULARY: the guard, its tests and documents about it all name the
// strings it matches, and counting those stops the rule discriminating at all. Not `:!*.md` — a
// guarded token in an ordinary README is exactly the evidence this wants.
const EXCLUDED = [':!.claude/hooks', ':!.omc', ':!docs', ':!CLAUDE.md'];

// Tracked files only, so an untracked scratch file cannot flip the verdict.
const ordinarySourceMatches = (pattern) => {
  const result = spawnSync(
    'git',
    ['grep', '--no-color', '-I', '-n', '-F', '-e', pattern, '--', '.', ...EXCLUDED],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  // git grep exits 1 for "no matches", which is the answer here, not a failure.
  if (result.status === 1) return [];
  assert.equal(result.status, 0, `git grep failed for ${pattern}: ${result.stderr}`);

  return (result.stdout ?? '').split('\n').filter(Boolean);
};

// One purpose: assembling this path has one outcome, so denying a read-only command containing it
// costs nothing anybody wanted.
test('I1: the dispatch endpoint is not ordinary vocabulary — over-blocking on it is allowed', () => {
  const matches = ordinarySourceMatches('/dispatches');

  assert.deepEqual(
    matches,
    [],
    `\`/dispatches\` appears in ordinary source, so it is vocabulary and the guard must NOT ` +
      `match it unconditionally:\n${matches.join('\n')}`,
  );
});

// The counter-case. Asserts the MEASUREMENT, not the fix: if `deliver` stops appearing in ordinary
// source the premise changed and checkInfraKit's conjunction can be revisited.
test('I1: `deliver` IS ordinary vocabulary — so the bare token may not deny on its own', () => {
  const matches = ordinarySourceMatches('deliver');

  assert.ok(
    matches.length > 0,
    'premise of the C3 conjunction: `deliver` was measured as ordinary vocabulary in this repo. ' +
      'If this now finds nothing, re-derive the policy rather than loosening the guard.',
  );
});
