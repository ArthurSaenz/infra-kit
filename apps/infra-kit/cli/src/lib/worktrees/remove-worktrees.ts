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
 * When `pruneFolder` is true and every branch was removed, also prune the
 * worktree metadata and delete the worktrees folder — used by the
 * `worktrees-remove` "all" path to leave the filesystem clean.
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

  // `git worktree remove` only deletes the leaf worktree, leaving the group
  // folder (e.g. `release/`, `feature/`) behind. Remove it when it's now empty;
  // `rmdir` is a no-op when the folder still holds other worktrees.
  const groupDirs = new Set<string>()

  for (const branch of removed) {
    if (branch.includes('/')) {
      groupDirs.add(`${worktreeDir}/${branch.split('/')[0]}`)
    }
  }

  for (const groupDir of groupDirs) {
    await $`rmdir ${groupDir}`.nothrow()
  }

  if (pruneFolder && removed.length === branches.length) {
    await $`git worktree prune`
    await $`rm -rf ${worktreeDir}`

    logger.info(`🗑️ Removed worktree folder: ${worktreeDir}`)
    logger.info('')
  }

  return removed
}
