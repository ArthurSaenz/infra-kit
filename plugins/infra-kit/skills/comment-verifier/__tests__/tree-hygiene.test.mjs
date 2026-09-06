// The two properties that survive a move of this skill and that no other test in the suite can see
// fail. Both are about `fix-pass.test.mjs`'s side effects on the real working tree, and both were
// fail-opens while the repo root was computed as `join(SKILL_DIR, '..', '..', '..')`:
//
//   - a root one level short retargets 20 writes and four recursive `rmSync` calls into a synthetic
//     `.claude` tree under `<repo>/plugins`, and the deletes only reach the innermost probe directory,
//     so the scaffolding above it survives the run while every assertion still passes;
//   - `git status --porcelain` on a pathspec that matches nothing exits 0 with empty output and
//     warns on stderr only, so the working-tree-untouched guarantee degrades to comparing empty
//     with empty. That is the guarantee the whole skill exists to offer.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { FIXTURES_DIR, REPO_ROOT, SCRIPT, fixture, fixturesPorcelain } from './paths.mjs'

const PLUGINS_DIR = join(REPO_ROOT, 'plugins')
const FIX_PASS = join(import.meta.dirname, 'fix-pass.test.mjs')

/**
 * Directories are listed as well as files: the residue the old arithmetic leaves is four *empty*
 * directories, which a file-only listing reports as identical to a clean tree.
 */
const treeUnderPlugins = () => readdirSync(PLUGINS_DIR, { recursive: true }).sort()

test('the fix-pass suite leaves the plugins tree exactly as it found it', () => {
  const before = treeUnderPlugins()
  // `NODE_TEST_CONTEXT` is inherited from the runner executing *this* file, and a child that sees it
  // serialises its results to the parent instead of printing them — stdout comes back empty and the
  // count assertions below cannot tell that from a suite that ran nothing.
  const { NODE_TEST_CONTEXT: _inherited, ...env } = process.env
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', FIX_PASS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  })

  assert.deepEqual(
    treeUnderPlugins(),
    before,
    'the fix-pass suite scaffolded or orphaned paths under plugins/ — its repo root is not the repo root',
  )
  assert.equal(run.status, 0, `the fix-pass suite itself failed:\n${run.stdout}${run.stderr}`)

  // A child that matched no test file also exits 0, which would make the comparison above vacuous.
  const counted = (label) => Number(new RegExp(`^# ${label} (\\d+)$`, 'm').exec(run.stdout)?.[1])
  assert.ok(counted('pass') > 0, `the child ran nothing:\n${run.stdout}`)
  assert.equal(counted('fail'), 0)
})

test('the porcelain pathspec sees an unsanctioned write at the new fixture location', () => {
  // The mutation stands in for a write a review-mode run should never make: a path under the fixture
  // tree that no verdict entry names, so nothing downstream would sanction it. A pathspec pointing
  // anywhere else — the pre-move copy of this skill under `.claude`, which still exists — leaves the
  // two porcelain calls equal and this assertion is the only thing that notices.
  const scope = [fixture('restating.ts'), fixture('clean.ts')]
  const probe = join(FIXTURES_DIR, 'pathspec-probe.ts')

  const before = fixturesPorcelain()
  const review = spawnSync(process.execPath, [SCRIPT, ...scope], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(review.status, 0, `review-mode run failed:\n${review.stderr}`)

  try {
    writeFileSync(probe, '// An unsanctioned write, standing in for one the run could have made.\n')
    assert.notEqual(
      fixturesPorcelain(),
      before,
      'git reported no change to the fixture tree after a file appeared in it — the pathspec is dead',
    )
  } finally {
    rmSync(probe, { force: true })
  }

  assert.equal(fixturesPorcelain(), before, 'the probe was not removed')
})
