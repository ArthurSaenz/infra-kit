/* eslint-disable sonarjs/cognitive-complexity */
import checkbox from '@inquirer/checkbox'
import confirm from '@inquirer/confirm'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { commandEcho } from 'src/lib/command-echo'
import { logger } from 'src/lib/logger'
import { detectReleaseType, formatBranchChoices, getJiraDescriptions } from 'src/lib/release-utils'
import type { RequiredConfirmedOptionArg, ToolsExecutionResult } from 'src/types'

interface GhMergeDevArgs extends RequiredConfirmedOptionArg {
  all: boolean
}

/**
 * Merge dev into every release branch
 */
export const ghMergeDev = async (args: GhMergeDevArgs): Promise<ToolsExecutionResult> => {
  const { all, confirmedCommand } = args

  commandEcho.start('merge-dev')

  // Only merge dev into regular releases (not hotfixes, which target main)
  const allPRs = await getReleasePRsWithInfo()
  const releasePRsList = allPRs
    .filter((pr) => {
      return detectReleaseType(pr.title) === 'regular'
    })
    .map((pr) => {
      return pr.branch
    })

  if (releasePRsList.length === 0) {
    logger.info('ℹ️ No open release branches found')

    commandEcho.print()

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ successfulMerges: 0, failedMerges: 0, failedBranches: [], totalBranches: 0 }, null, 2),
        },
      ],
      structuredContent: { successfulMerges: 0, failedMerges: 0, failedBranches: [], totalBranches: 0 },
    }
  }

  let selectedReleaseBranches: string[] = []

  if (all) {
    selectedReleaseBranches = releasePRsList
  } else {
    commandEcho.setInteractive()

    const descriptions = await getJiraDescriptions()

    selectedReleaseBranches = await checkbox({
      required: true,
      message: '🌿 Select release branches',
      choices: formatBranchChoices({ branches: releasePRsList, descriptions }),
    })
  }

  // Track --all flag if all branches were selected (either via flag or interactively)
  const allSelected = selectedReleaseBranches.length === releasePRsList.length

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

  // Validate input
  // if (selectedReleaseBranches.length === 0) {
  //   console.error('No branches provided. Exiting...')
  //   process.exit(1)
  // }

  const answer = confirmedCommand
    ? true
    : await confirm({
        message: `Are you sure you want to merge dev into these branches: ${selectedReleaseBranches.join(', ')}?`,
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

  $.quiet = true

  await $`git fetch origin`
  await $`git switch dev`
  await $`git pull origin dev`

  const failedBranches: string[] = []

  // Merge dev into each branch
  for (const branch of selectedReleaseBranches) {
    const success = await mergeDev(branch)

    if (!success) {
      failedBranches.push(branch)
    }
  }

  $.quiet = false

  if (failedBranches.length > 0) {
    logger.info(`\n⚠️  ${failedBranches.length} branch(es) failed to merge automatically.\n`)
    logger.info('📋 Manual merge script for failed branches:')
    for (const branch of failedBranches) {
      logger.info(
        `# Merge dev into ${branch} and resolve conflicts if any \n\ngit switch ${branch} && git pull origin ${branch} && git merge origin/dev\ngit push origin ${branch} && git switch dev\n`,
      )
    }
    logger.info(
      `✅ ${selectedReleaseBranches.length - failedBranches.length}/${selectedReleaseBranches.length} merges completed successfully.`,
    )
  } else {
    logger.info('✅ All merges completed successfully!\n')
  }

  commandEcho.print()

  const structuredContent = {
    successfulMerges: selectedReleaseBranches.length - failedBranches.length,
    failedMerges: failedBranches.length,
    failedBranches,
    totalBranches: selectedReleaseBranches.length,
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
}

const mergeDev = async (branch: string): Promise<boolean> => {
  try {
    await $`git switch ${branch}`

    await $`git pull origin ${branch}`

    await $`git merge origin/dev --no-edit`

    await $`git push origin ${branch}`

    await $`git switch dev`

    logger.info(`Successfully merged dev into ${branch}`)

    return true
  } catch (error: unknown) {
    logger.error({ error, branch }, `Error merging dev into ${branch}`)

    await $`git reset --merge HEAD~1`

    return false
  }
}

// MCP Tool Registration
export const ghMergeDevMcpTool = {
  name: 'gh-merge-dev',
  description:
    'Merge origin/dev into every open regular (non-hotfix) release branch and push the result. Mutates local git state and the remote release branches. When invoked via MCP, pass all=true — the branch picker is unreachable without a TTY, and the confirmation prompt is auto-skipped for MCP calls, so the caller is responsible for gating. Irreversible once pushed.',
  inputSchema: {
    all: z
      .boolean()
      .optional()
      .describe(
        'Target every open regular release branch. Must be true for MCP calls (the interactive picker is unavailable without a TTY).',
      ),
  },
  outputSchema: {
    successfulMerges: z.number().describe('Number of successful merges'),
    failedMerges: z.number().describe('Number of failed merges'),
    failedBranches: z.array(z.string()).describe('List of branches that failed to merge'),
    totalBranches: z.number().describe('Total number of branches processed'),
  },
  handler: ghMergeDev,
}
