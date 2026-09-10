import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { OperationError } from 'src/lib/errors/operation-error'
import { getCurrentWorktrees, getProjectRoot } from 'src/lib/git-utils'

import { removeWorktrees } from './remove-worktrees'

export interface RemoveReleaseWorktreeMessages {
  /** Reported operation, e.g. "remove worktree for X before merge" — context differs per caller. */
  operation: string
  /**
   * Reported remediation. Required, with no shared default: this repo has deliberately refused
   * `--force` on `worktrees remove` (readme.md's Worktrees row; `removeOne` runs
   * `git worktree remove` bare), so a hoisted default string here could leak a `--force`
   * suggestion into a caller — such as a teardown flow — that must never offer it. Requiring both
   * fields forces every caller, present and future, to state its own.
   */
  remediation: string
}

/**
 * `gh pr merge --delete-branch` also deletes the local branch, which fails if a
 * worktree has it checked out (the actual root cause of the "Failed to merge
 * release PR" surface error). Pre-remove any worktree for the release branch
 * so the local delete can succeed.
 *
 * Returns the branches actually removed (empty when none were present), because
 * `removeIdeWorktreeFolders` treats an empty `removedWorktrees` list as "nothing to clean up"
 * and returns immediately — a `void`-returning helper would make that step a silent no-op for
 * a caller chaining IDE-folder cleanup off this result.
 */
export const removeReleaseWorktreeIfPresent = async (
  releaseBranch: string,
  messages: RemoveReleaseWorktreeMessages,
): Promise<string[]> => {
  const worktreeBranches = await getCurrentWorktrees('release')

  if (!worktreeBranches.includes(releaseBranch)) return []

  const projectRoot = await getProjectRoot()
  const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

  const { removed, failed } = await removeWorktrees({ branches: [releaseBranch], worktreeDir, projectRoot })

  // Check membership, not emptiness: `removed` is one of two result lists now.
  if (!removed.includes(releaseBranch)) {
    const failure = failed.find((entry) => {
      return entry.branch === releaseBranch
    })

    throw new OperationError(undefined, { ...messages, stderrExcerpt: failure?.reason })
  }

  return removed
}
