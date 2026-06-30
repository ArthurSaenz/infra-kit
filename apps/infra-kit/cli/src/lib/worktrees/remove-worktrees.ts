import { $ } from 'zx'

import { buildCmuxWorkspaceTitle, closeCmuxWorkspaceByTitle } from 'src/integrations/cmux'
import { OperationError } from 'src/lib/errors/operation-error'
import { logger } from 'src/lib/logger'

interface RemoveWorktreesArgs {
  branches: string[]
  worktreeDir: string
  repoName: string
  pruneFolder?: boolean
}

/**
 * Close any cmux workspace for each branch and run `git worktree remove`,
 * returning the branches that were removed cleanly. Failures are logged but
 * never thrown, so a single bad worktree doesn't poison a batch removal.
 *
 * When `pruneFolder` is true and every branch was removed, also run
 * `git worktree prune` to clear stale worktree metadata. The `<repo>-worktrees`
 * container directory and its `release/`/`feature/` subfolders are deliberately
 * left in place so the per-repo worktree scaffold persists even when empty.
 */
export const removeWorktrees = async (args: RemoveWorktreesArgs): Promise<string[]> => {
  const { branches, worktreeDir, repoName, pruneFolder = false } = args

  const results = await Promise.allSettled(
    branches.map(async (branch) => {
      const worktreePath = `${worktreeDir}/${branch}`

      const title = buildCmuxWorkspaceTitle({ repoName, branch })

      await closeCmuxWorkspaceByTitle(title)

      await $`git worktree remove ${worktreePath}`

      return branch
    }),
  )

  const removed: string[] = []

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      removed.push(result.value)
    } else {
      const branch = branches[index]
      const err = new OperationError(result.reason, {
        operation: `remove worktree for ${branch}`,
        remediation: "check 'git worktree list' for the path; uncommitted changes block removal",
      })

      logger.error({ error: result.reason, msg: err.message })
    }
  }

  // `git worktree remove` deletes only the leaf worktree. We intentionally leave
  // the `<repo>-worktrees` container and its `release/`/`feature/` group folders
  // in place so the worktree scaffold survives an empty state (it is recreated
  // lazily by `worktrees-add` via `mkdir -p` regardless).
  if (pruneFolder && removed.length === branches.length) {
    await $`git worktree prune`
  }

  return removed
}
