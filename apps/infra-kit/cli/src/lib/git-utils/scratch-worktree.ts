import path from 'node:path'
import process from 'node:process'
import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'

/**
 * A disposable detached worktree that `gh-merge-dev` merges inside of.
 *
 * The whole point is that no checkout anyone else owns is touched: the release
 * branches this command merges into are, on this team, almost always checked out
 * in linked worktrees already, so `git switch` — the old engine — fails on the
 * ordinary case rather than the exceptional one.
 */
export interface ScratchWorktree {
  /** Absolute path of the scratch checkout. */
  path: string
  /** Remove the worktree registration and its directory. Never throws. */
  remove: () => Promise<void>
}

/**
 * Where the scratch worktree lives: `<git-common-dir>/infra-kit/merge-dev-<runId>`, with `runId`
 * taken from `INFRA_KIT_SESSION` (this repo's per-terminal id) and falling back to the pid.
 *
 * Two properties are load-bearing: the path is outside every working tree, and it is unique per run.
 */
// Both are about NOT colliding with things that already exist.
//
// 1. Outside every working tree. An untracked directory inside the main checkout would make
//    `isWorkingTreeClean` false, and therefore `assertManagementContext` throw, for every OTHER
//    release and worktree command in this CLI — so a crashed `gh-merge-dev` would break
//    `worktrees add` and `release create` with a message naming neither of them. Under `.git/`
//    it is invisible to `git status` by construction.
// 2. Unique per run. A colliding path is a hard `fatal: … already exists`, so two concurrent runs
//    would fight.
//
// It also deliberately avoids the team's `<projectRoot>-worktrees/` convention, which
// `getCurrentWorktrees` scans for release branches.
export const scratchWorktreePath = async (cwd?: string): Promise<string> => {
  const root = cwd ?? process.cwd()
  const commonDir = (await $({ cwd: root, quiet: true })`git rev-parse --git-common-dir`).stdout.trim()
  const runId = process.env.INFRA_KIT_SESSION || String(process.pid)

  return path.join(path.resolve(root, commonDir), 'infra-kit', `merge-dev-${runId}`)
}

/** Whether a merge is in progress in `cwd`. Never throws. */
export const hasMergeInProgress = async (cwd: string): Promise<boolean> => {
  try {
    await $({ cwd, quiet: true })`git rev-parse -q --verify MERGE_HEAD`

    return true
  } catch {
    return false
  }
}

/**
 * Refuse to reuse a scratch worktree that is not pristine.
 *
 * This converts a cleanup miss into a fail-fast instead of a cascade. The
 * failure it guards against is measurable: after a conflicting merge is left
 * unaborted, the next `git checkout --detach` fails with `error: you need to
 * resolve your current index first`, so branch k's conflict would be reported as
 * an error on branches k+1…N — the same class of silently-wrong per-branch
 * result the new engine exists to eliminate.
 */
export const assertPristineWorktree = async (cwd: string): Promise<void> => {
  if (await hasMergeInProgress(cwd)) {
    throw new OperationError(undefined, {
      operation: 'reuse the scratch worktree',
      stderrExcerpt: 'a merge is still in progress in the scratch worktree',
      remediation: 'this is an infra-kit bug — the previous branch iteration did not clean up',
    })
  }

  const status = (await $({ cwd, quiet: true })`git status --porcelain`).stdout.trim()

  if (status.length > 0) {
    throw new OperationError(undefined, {
      operation: 'reuse the scratch worktree',
      stderrExcerpt: `scratch worktree is dirty: ${status.split('\n')[0]}`,
      remediation: 'this is an infra-kit bug — the previous branch iteration did not clean up',
    })
  }
}

/**
 * Return the scratch worktree to a pristine state between branch iterations.
 * Never throws: it runs in a `finally`, and a cleanup that can throw would
 * re-create the very defect (a rejection escaping a catch/finally and killing
 * the run) that this rewrite removes.
 *
 * `clean -fd`, not `-fdx`: ignored paths survive, so a `node_modules` installed
 * by `--verify` on one branch is reused by the next instead of being reinstalled
 * from cold. That makes the `qa` verify tier non-hermetic, which is a deliberate
 * trade recorded in the plan — the cheap `install` tier is unaffected, because it
 * reads the lockfile and manifests rather than executing installed code.
 */
export const resetScratchWorktree = async (cwd: string): Promise<void> => {
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch {
      // Best-effort by contract; `assertPristineWorktree` is the real gate.
    }
  }

  if (await hasMergeInProgress(cwd)) {
    // Guarded: an unconditional `git merge --abort` exits 128 when there is no
    // merge to abort, and this runs on paths where there often is not.
    await run(() => {
      return $({ cwd, quiet: true })`git merge --abort`
    })
  }

  await run(() => {
    return $({ cwd, quiet: true })`git reset --hard`
  })

  // `reset --hard` leaves untracked files behind, which would fail the pristine
  // assertion on the next iteration.
  await run(() => {
    return $({ cwd, quiet: true })`git clean -fd`
  })
}

/**
 * Create the scratch worktree, hand it to `fn`, and always remove it.
 *
 * Anchored on `origin/dev` rather than on the first candidate branch: a branch
 * deleted on origin between the PR listing and the fetch would make the initial
 * `add` fail, and a preflight throw there would kill the run for every *other*
 * branch too. `origin/dev` is verified by the caller immediately beforehand.
 *
 * A stale registration left by a hard kill (`fatal: … is a missing but already
 * registered worktree`) is recovered once via `git worktree prune`, because
 * otherwise the command would be broken on that machine every subsequent run.
 */
export const withScratchWorktree = async <T>(
  args: { cwd: string; anchor?: string },
  fn: (worktree: ScratchWorktree) => Promise<T>,
): Promise<T> => {
  const { cwd, anchor = 'origin/dev' } = args
  const worktreePath = await scratchWorktreePath(cwd)

  const add = async (): Promise<void> => {
    await $({ cwd, quiet: true })`git worktree add --detach ${worktreePath} ${anchor}`
  }

  try {
    await add()
  } catch (firstError) {
    try {
      await $({ cwd, quiet: true })`git worktree prune`
      await add()
    } catch {
      throw new OperationError(firstError, {
        operation: 'create the scratch worktree for the merge',
        remediation: `remove any stale checkout at ${worktreePath}, then retry`,
      })
    }
  }

  const worktree: ScratchWorktree = {
    path: worktreePath,
    remove: async (): Promise<void> => {
      try {
        await $({ cwd, quiet: true })`git worktree remove --force ${worktreePath}`
      } catch {
        // A leftover registration is recoverable (`prune`-and-retry on the next
        // run); throwing here would mask whatever the run was actually reporting.
      }
    },
  }

  try {
    return await fn(worktree)
  } finally {
    await worktree.remove()
  }
}
