import checkbox from '@inquirer/checkbox'
import confirm from '@inquirer/confirm'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { commandEcho } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { getCurrentWorktrees, getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { detectReleaseType, formatBranchChoices, getJiraDescriptions } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import type { RequiredConfirmedOptionArg, ToolsExecutionResult } from 'src/types'

// Constants
interface WorktreeManagementArgs extends RequiredConfirmedOptionArg {
  all: boolean
  versions?: string
}

/**
 * Manage git worktrees for release branches
 * Creates worktrees for active release branches and removes unused ones
 */
export const worktreesRemove = async (options: WorktreeManagementArgs): Promise<ToolsExecutionResult> => {
  const { confirmedCommand, all, versions } = options

  commandEcho.start('worktrees-remove')

  try {
    const currentWorktrees = await getCurrentWorktrees('release')

    if (currentWorktrees.length === 0) {
      logger.info('ℹ️ No active worktrees to remove')

      commandEcho.print()

      return {
        content: [{ type: 'text', text: JSON.stringify({ removedWorktrees: [], count: 0 }, null, 2) }],
        structuredContent: { removedWorktrees: [], count: 0 },
      }
    }

    const projectRoot = await getProjectRoot()

    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

    let selectedReleaseBranches: string[] = []

    if (all) {
      selectedReleaseBranches = currentWorktrees
    } else if (versions) {
      selectedReleaseBranches = versions.split(',').map((v) => {
        return `release/v${v.trim()}`
      })
    } else {
      commandEcho.setInteractive()

      const [descriptions, prInfo] = await Promise.all([getJiraDescriptions(), getReleasePRsWithInfo()])

      const releaseTypes = new Map<string, ReleaseType>(
        prInfo.map((pr) => {
          return [pr.branch, detectReleaseType(pr.title)]
        }),
      )

      selectedReleaseBranches = await checkbox({
        required: true,
        message: '🌿 Select release branches',
        choices: formatBranchChoices({ branches: currentWorktrees, descriptions, types: releaseTypes }),
      })
    }

    // Track --all flag if all branches were selected (either via flag or interactively)
    const allSelected = selectedReleaseBranches.length === currentWorktrees.length

    if (allSelected) {
      commandEcho.addOption('--all', true)
    } else {
      commandEcho.addOption(
        '--versions',
        selectedReleaseBranches.map((branch) => {
          return branch.replace('release/v', '')
        }),
      )
    }

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

    const removedWorktrees = await removeWorktrees(selectedReleaseBranches, worktreeDir)

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

/**
 * Remove worktrees for the specified branches and whole folder
 */
const removeWorktrees = async (branches: string[], worktreeDir: string): Promise<string[]> => {
  const results = await Promise.allSettled(
    branches.map(async (branch) => {
      const worktreePath = `${worktreeDir}/${branch}`

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

      logger.error({ error: result.reason }, `❌ Failed to remove worktree for ${branch}`)
    }
  }

  if (removed.length === branches.length) {
    await $`git worktree prune`
    await $`rm -rf ${worktreeDir}`

    logger.info(`🗑️ Removed worktree folder: ${worktreeDir}`)
    logger.info('')
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
export const worktreesRemoveMcpTool = {
  name: 'worktrees-remove',
  description:
    'Remove local git worktrees for release branches. When everything is removed, also runs "git worktree prune" and deletes the worktrees directory. When invoked via MCP, pass either "versions" (comma-separated) or all=true — the branch picker is unreachable without a TTY, and the CLI confirmation is auto-skipped for MCP calls, so the caller is responsible for gating.',
  inputSchema: {
    all: z
      .boolean()
      .optional()
      .describe(
        'Remove every existing worktree. Either "all" or "versions" must be provided for MCP calls (the interactive picker is unavailable without a TTY). Ignored if "versions" is provided.',
      ),
    versions: z
      .string()
      .optional()
      .describe(
        'Comma-separated release versions to target (e.g. "1.2.5, 1.2.6"). Either "versions" or all=true must be provided for MCP calls. Overrides "all" when set.',
      ),
  },
  outputSchema: {
    removedWorktrees: z.array(z.string()).describe('List of removed git worktree branches'),
    count: z.number().describe('Number of git worktrees removed'),
  },
  handler: worktreesRemove,
}
