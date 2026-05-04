import confirm from '@inquirer/confirm'
import process from 'node:process'
import { z } from 'zod/v4'
import { $ } from 'zx'

import { buildCmuxWorkspaceTitle, closeCmuxWorkspaceByTitle } from 'src/integrations/cmux'
import { removeFoldersFromCursorWorkspace, resolveCursorWorkspacePath } from 'src/integrations/cursor'
import { getReleasePRs } from 'src/integrations/gh'
import { commandEcho } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { getCurrentWorktrees, getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import type { RequiredConfirmedOptionArg, ToolsExecutionResult } from 'src/types'

// Constants
const RELEASE_BRANCH_PREFIX = 'release/v'

interface WorktreeSyncArgs extends RequiredConfirmedOptionArg {}

/**
 * Manage git worktrees for release branches.
 *
 * Creates worktrees for active release branches and removes unused ones
 */
export const worktreesSync = async (options: WorktreeSyncArgs): Promise<ToolsExecutionResult> => {
  const { confirmedCommand } = options

  commandEcho.start('worktrees-sync')

  try {
    const currentWorktrees = await getCurrentWorktrees('release')
    const projectRoot = await getProjectRoot()

    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

    const releasePRsList = await getReleasePRs()

    // Ask for confirmation
    const answer = confirmedCommand
      ? true
      : await confirm({
          message: 'Are you sure you want to proceed with these worktree changes?',
        })

    if (!confirmedCommand) {
      commandEcho.setInteractive()
    }

    if (!answer) {
      logger.info('Operation cancelled. Exiting...')
      process.exit(0)
    }

    // Track --yes flag if confirmation was interactive (user confirmed)
    if (!confirmedCommand) {
      commandEcho.addOption('--yes', true)
    }

    const { branchesToRemove } = categorizeWorktrees({
      releasePRsList,
      currentWorktrees,
    })

    const repoName = await getRepoName()

    const removedWorktrees = await removeWorktrees({
      branches: branchesToRemove,
      worktreeDir,
      repoName,
    })

    await syncCursorWorkspaceOnRemove({ removedWorktrees, worktreeDir, projectRoot })

    logResults(removedWorktrees)

    commandEcho.print()

    const structuredContent = {
      removedWorktrees,
      count: removedWorktrees.length,
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent,
    }
  } catch (error) {
    logger.error({ error }, '❌ Error managing worktrees')
    throw error
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
    return branch.startsWith(RELEASE_BRANCH_PREFIX)
  })

  const branchesToRemove = currentBranchNames.filter((branch) => {
    return !releasePRsList.includes(branch)
  })

  return { branchesToRemove }
}

interface RemoveWorktreesArgs {
  branches: string[]
  worktreeDir: string
  repoName: string
}

/**
 * Remove worktrees for the specified branches and close their cmux workspaces
 */
const removeWorktrees = async (args: RemoveWorktreesArgs): Promise<string[]> => {
  const { branches, worktreeDir, repoName } = args

  const removed: string[] = []

  for (const branch of branches) {
    try {
      const worktreePath = `${worktreeDir}/${branch}`

      const title = buildCmuxWorkspaceTitle({ repoName, branch })

      await closeCmuxWorkspaceByTitle(title)

      await $`git worktree remove ${worktreePath}`
      removed.push(branch)
    } catch (error) {
      logger.error({ error, branch }, `❌ Failed to remove worktree for ${branch}`)
    }
  }

  return removed
}

interface SyncCursorWorkspaceOnRemoveArgs {
  removedWorktrees: string[]
  worktreeDir: string
  projectRoot: string
}

/**
 * Strip removed worktrees from the configured Cursor workspace's `folders` array.
 * No-op if Cursor isn't configured, mode isn't "workspace", or no worktrees were removed.
 */
const syncCursorWorkspaceOnRemove = async (args: SyncCursorWorkspaceOnRemoveArgs): Promise<void> => {
  const { removedWorktrees, worktreeDir, projectRoot } = args

  if (removedWorktrees.length === 0) {
    return
  }

  const config = await getInfraKitConfig()
  const cursorConfig = config.ide?.provider === 'cursor' ? config.ide.config : undefined

  if (!cursorConfig || cursorConfig.mode !== 'workspace' || !cursorConfig.workspaceConfigPath) {
    return
  }

  const workspacePath = resolveCursorWorkspacePath(cursorConfig.workspaceConfigPath, projectRoot)

  const folderPaths = removedWorktrees.map((branch) => {
    return `${worktreeDir}/${branch}`
  })

  try {
    const { removed: removedEntries } = await removeFoldersFromCursorWorkspace({ workspacePath, folderPaths })

    if (removedEntries.length > 0) {
      logger.info(`✅ Removed ${removedEntries.length} folder(s) from ${workspacePath}`)
    }
  } catch (error) {
    logger.warn({ error }, `⚠️ Failed to update Cursor workspace at ${workspacePath}`)
  }
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
export const worktreesSyncMcpTool = {
  name: 'worktrees-sync',
  description:
    'Remove worktrees whose release PR is no longer open (stale cleanup). Only removes — never creates; use worktrees-add to create worktrees for new releases. The CLI confirmation is auto-skipped for MCP calls, so the caller is responsible for gating.',
  inputSchema: {},
  outputSchema: {
    removedWorktrees: z.array(z.string()).describe('List of removed worktree branches'),
    count: z.number().describe('Number of worktrees removed during sync'),
  },
  handler: worktreesSync,
}
