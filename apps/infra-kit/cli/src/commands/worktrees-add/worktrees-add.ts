/* eslint-disable sonarjs/cognitive-complexity */
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
const FEATURE_DIR = 'feature'
const RELEASE_DIR = 'release'
const RELEASE_BRANCH_PREFIX = 'release/v'

interface WorktreeManagementArgs extends RequiredConfirmedOptionArg {
  all: boolean
  versions?: string
  cursor?: boolean
  githubDesktop?: boolean
}

/**
 * Manage git worktrees for release branches
 * Creates worktrees for active release branches and removes unused ones
 */
export const worktreesAdd = async (options: WorktreeManagementArgs): Promise<ToolsExecutionResult> => {
  const { confirmedCommand, all, versions, cursor, githubDesktop } = options

  commandEcho.start('worktrees-add')

  try {
    const currentWorktrees = await getCurrentWorktrees('release')
    const projectRoot = await getProjectRoot()

    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

    await ensureWorktreeDirectory(`${worktreeDir}/${RELEASE_DIR}`)
    await ensureWorktreeDirectory(`${worktreeDir}/${FEATURE_DIR}`)

    let selectedReleaseBranches: string[] = []

    if (versions) {
      selectedReleaseBranches = versions.split(',').map((v) => {
        return `release/v${v.trim()}`
      })
    } else {
      const releasePRsInfo = await getReleasePRsWithInfo()

      const releasePRsList = releasePRsInfo.map((pr) => {
        return pr.branch
      })

      if (releasePRsList.length === 0) {
        logger.info('ℹ️ No open release branches found')

        commandEcho.print()

        return {
          content: [{ type: 'text', text: JSON.stringify({ createdWorktrees: [], count: 0 }, null, 2) }],
          structuredContent: { createdWorktrees: [], count: 0 },
        }
      }

      if (all) {
        selectedReleaseBranches = releasePRsList
      } else {
        commandEcho.setInteractive()

        const releaseTypes = new Map<string, ReleaseType>(
          releasePRsInfo.map((pr) => {
            return [pr.branch, detectReleaseType(pr.title)]
          }),
        )

        const descriptions = await getJiraDescriptions()

        selectedReleaseBranches = await checkbox({
          required: true,
          message: '🌿 Select release branches',
          choices: formatBranchChoices({ branches: releasePRsList, descriptions, types: releaseTypes }),
        })
      }
    }

    // Track --all flag if all branches were selected (either via flag or interactively)
    if (all) {
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

    const openInCursor = cursor ?? (await confirm({ message: 'Open created worktrees in Cursor?' }))

    if (typeof cursor === 'undefined') {
      commandEcho.setInteractive()
    }

    if (openInCursor) {
      commandEcho.addOption('--cursor', true)
    } else {
      commandEcho.addOption('--no-cursor', true)
    }

    const openInGithubDesktop =
      githubDesktop ?? (await confirm({ message: 'Open created worktrees in GitHub Desktop?' }))

    if (typeof githubDesktop === 'undefined') {
      commandEcho.setInteractive()
    }

    if (openInGithubDesktop) {
      commandEcho.addOption('--github-desktop', true)
    } else {
      commandEcho.addOption('--no-github-desktop', true)
    }

    const { branchesToCreate } = categorizeWorktrees({
      selectedReleaseBranches,
      currentWorktrees,
    })

    const createdWorktrees = await createWorktrees(branchesToCreate, worktreeDir)

    logResults(createdWorktrees)

    if (openInCursor) {
      for (const branch of createdWorktrees) {
        await $`cursor ${worktreeDir}/${branch}`
      }
    }

    if (openInGithubDesktop) {
      for (const branch of createdWorktrees) {
        await $`github ${worktreeDir}/${branch}`
        await $`sleep 5`
      }
    }

    commandEcho.print()

    const structuredContent = {
      createdWorktrees,
      count: createdWorktrees.length,
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
 * Ensure the worktree directory exists
 */
const ensureWorktreeDirectory = async (worktreeDir: string): Promise<void> => {
  await $`mkdir -p ${worktreeDir}`
}

interface CategorizeWorktreesArgs {
  selectedReleaseBranches: string[]
  currentWorktrees: string[]
}

/**
 * Categorize release worktrees into those that need to be created or removed
 */
const categorizeWorktrees = (args: CategorizeWorktreesArgs): { branchesToCreate: string[] } => {
  const { selectedReleaseBranches, currentWorktrees } = args

  const currentBranchNames = currentWorktrees.filter((branch) => {
    return branch.startsWith(RELEASE_BRANCH_PREFIX)
  })

  const branchesToCreate = selectedReleaseBranches.filter((branch) => {
    return !currentBranchNames.includes(branch)
  })

  return { branchesToCreate }
}

/**
 * Create worktrees for the specified branches
 */
const createWorktrees = async (branches: string[], worktreeDir: string): Promise<string[]> => {
  const results = await Promise.allSettled(
    branches.map(async (branch) => {
      const worktreePath = `${worktreeDir}/${branch}`

      await $`git worktree add ${worktreePath} ${branch}`
      await $({ cwd: worktreePath })`pnpm install`

      return branch
    }),
  )

  const created: string[] = []

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      created.push(result.value)
    } else {
      const branch = branches[index]

      logger.error({ error: result.reason }, `❌ Failed to create worktree for ${branch}`)
    }
  }

  return created
}

/**
 * Log the results of worktree management
 */
const logResults = (created: string[]): void => {
  if (created.length > 0) {
    logger.info('✅ Created git worktrees:')
    for (const branch of created) {
      logger.info(branch)
    }
    logger.info('')
  } else {
    logger.info('ℹ️ No new git worktrees to create')
  }
}

// MCP Tool Registration
export const worktreesAddMcpTool = {
  name: 'worktrees-add',
  description:
    'Create local git worktrees for release branches under the worktrees directory and run "pnpm install" in each. Mutates the local filesystem. When invoked via MCP, pass either "versions" (comma-separated) or all=true — the branch picker and "open in Cursor / GitHub Desktop" follow-up prompts are unreachable without a TTY, and the CLI confirmation is auto-skipped for MCP calls.',
  inputSchema: {
    all: z
      .boolean()
      .optional()
      .describe(
        'Add worktrees for every open release branch. Either "all" or "versions" must be provided for MCP calls (the interactive picker is unavailable without a TTY). Ignored if "versions" is provided.',
      ),
    versions: z
      .string()
      .optional()
      .describe(
        'Comma-separated release versions to target (e.g. "1.2.5, 1.2.6"). Either "versions" or all=true must be provided for MCP calls. Overrides "all" when set.',
      ),
    cursor: z
      .boolean()
      .optional()
      .describe(
        'Open each created worktree in Cursor. Defaults to false in MCP mode (the follow-up prompt is not shown).',
      ),
    githubDesktop: z
      .boolean()
      .optional()
      .describe(
        'Open each created worktree in GitHub Desktop. Defaults to false in MCP mode (the follow-up prompt is not shown).',
      ),
  },
  outputSchema: {
    createdWorktrees: z.array(z.string()).describe('List of created git worktree branches'),
    count: z.number().describe('Number of git worktrees created'),
  },
  handler: worktreesAdd,
}
