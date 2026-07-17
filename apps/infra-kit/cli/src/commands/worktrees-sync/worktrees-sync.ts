import { z } from 'zod'
import { $ } from 'zx'

import { closeCmuxWorkspaceByCwd } from 'src/integrations/cmux'
import { getReleasePRs } from 'src/integrations/gh'
import { removeIdeWorktreeFolders } from 'src/integrations/ide'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { isReleaseBranch } from 'src/lib/release-id'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

interface WorktreeSyncArgs extends RequiredConfirmedOptionArg {}

/**
 * Manage git worktrees for release branches.
 *
 * Creates worktrees for active release branches and removes unused ones
 */
export const worktreesSync = async (options: WorktreeSyncArgs) => {
  const { confirmedCommand } = options

  // Branch-agnostic: reconciles worktrees by name/path and never reads HEAD, so
  // only the worktree + clean-tree legs apply. Load-bearing on the MCP path,
  // which runs this unattended — a branch requirement there would refuse a
  // cleanup that has no quarrel with the caller's checkout.
  await assertManagementContext({ operation: 'sync worktrees' })

  try {
    const currentWorktrees = await getCurrentWorktrees('release')
    const projectRoot = await getProjectRoot()

    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

    const releasePRsList = await getReleasePRs()

    // Ask for confirmation
    await confirmOrExit(confirmedCommand, 'Are you sure you want to proceed with these worktree changes?')

    // Track --yes flag if confirmation was interactive (user confirmed)
    if (!confirmedCommand) {
      commandEcho.addOption('--yes', true)
    }

    const { branchesToRemove } = categorizeWorktrees({
      releasePRsList,
      currentWorktrees,
    })

    const removedWorktrees = await removeWorktrees({
      branches: branchesToRemove,
      worktreeDir,
    })

    // Hard `false`: sync is background/stale-cleanup (predominantly the MCP path) — it must never
    // relaunch and overwrite a focused Zed window. Zed removal stays a no-op here.
    await removeIdeWorktreeFolders({
      projectRoot,
      worktreeDir,
      currentWorktrees,
      removedWorktrees,
      allowEditorRelaunch: false,
    })

    logResults(removedWorktrees)

    commandEcho.print()

    const structuredContent = {
      removedWorktrees,
      count: removedWorktrees.length,
    }

    return {
      content: textContent(JSON.stringify(structuredContent, null, 2)),
      structuredContent,
    }
  } catch (error) {
    // A cancelled prompt (Ctrl-C / Esc) is a user back-out, not a failure: let it
    // reach the top-level boundary untouched so it exits cleanly, instead of being
    // logged as an error with a misleading remediation.
    if (isPromptCancellation(error)) throw error

    logger.error({ error }, '❌ Error managing worktrees')
    throw new OperationError(error, {
      operation: 'sync worktrees with remote',
      remediation: "ensure 'gh auth status' is ok and you can reach origin",
    })
  }
}

interface CategorizeWorktreesArgs {
  releasePRsList: string[]
  currentWorktrees: string[]
}

/**
 * Categorize worktrees into those that need to be created or removed
 */
const categorizeWorktrees = (args: CategorizeWorktreesArgs): { branchesToRemove: string[] } => {
  const { releasePRsList, currentWorktrees } = args

  const currentBranchNames = currentWorktrees.filter((branch) => {
    return isReleaseBranch(branch)
  })

  const branchesToRemove = currentBranchNames.filter((branch) => {
    return !releasePRsList.includes(branch)
  })

  return { branchesToRemove }
}

interface RemoveWorktreesArgs {
  branches: string[]
  worktreeDir: string
}

/**
 * Remove worktrees for the specified branches and close their cmux workspaces
 */
const removeWorktrees = async (args: RemoveWorktreesArgs): Promise<string[]> => {
  const { branches, worktreeDir } = args

  const removed: string[] = []

  for (const branch of branches) {
    try {
      const worktreePath = `${worktreeDir}/${branch}`

      // Close the cmux workspace by cwd (before `git worktree remove`, so the path
      // still exists); anchors are excluded so a group header is never closed.
      await closeCmuxWorkspaceByCwd(worktreePath)

      await $`git worktree remove ${worktreePath}`
      removed.push(branch)
    } catch (error) {
      const err = new OperationError(error, {
        operation: `remove stale worktree for ${branch}`,
        remediation: 'inspect the worktree dir manually; rerun with the branch checked out elsewhere',
      })

      logger.error({ error, branch, msg: err.message })
    }
  }

  return removed
}

/**
 * Log the results of worktree management
 */
const logResults = (removed: string[]): void => {
  if (removed.length > 0) {
    logger.info('❌ Removed worktrees:')
    for (const branch of removed) {
      logger.info(branch)
    }
    logger.info('')
  } else {
    logger.info('ℹ️ No unused worktrees to remove')
  }
}

// MCP Tool Registration
export const worktreesSyncMcpTool = defineMcpTool({
  name: 'worktrees-sync',
  description:
    'Remove worktrees whose release PR is no longer open (stale cleanup). Only removes — never creates; use worktrees-add to create worktrees for new releases. The CLI confirmation is auto-skipped for MCP calls, so the caller is responsible for gating.',
  inputSchema: {},
  outputSchema: {
    removedWorktrees: z.array(z.string()).describe('List of removed worktree branches'),
    count: z.number().describe('Number of worktrees removed during sync'),
  },
  handler: worktreesSync,
})
