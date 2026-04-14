import confirm from '@inquirer/confirm'
import select from '@inquirer/select'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { deliverJiraRelease, loadJiraConfigOptional } from 'src/integrations/jira'
import { commandEcho } from 'src/lib/command-echo'
import { logger } from 'src/lib/logger'
import { detectReleaseType, formatBranchChoices, getJiraDescriptions } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import type { RequiredConfirmedOptionArg, ToolsExecutionResult } from 'src/types'

interface GhReleaseDeliverArgs extends RequiredConfirmedOptionArg {
  version: string
}

/**
 * Deliver a release branch to production
 */
export const ghReleaseDeliver = async (args: GhReleaseDeliverArgs): Promise<ToolsExecutionResult> => {
  const { version, confirmedCommand } = args

  commandEcho.start('release-deliver')

  const releasePRsInfo = await getReleasePRsWithInfo()

  const branches = releasePRsInfo.map((pr) => {
    return pr.branch
  })

  const releaseTypes = new Map<string, ReleaseType>(
    releasePRsInfo.map((pr) => {
      return [pr.branch, detectReleaseType(pr.title)]
    }),
  )

  let selectedReleaseBranch = '' // "release/v1.8.0"

  if (version) {
    selectedReleaseBranch = `release/v${version}`
  } else {
    commandEcho.setInteractive()

    const descriptions = await getJiraDescriptions()

    selectedReleaseBranch = await select({
      message: '🌿 Select release branch',
      choices: formatBranchChoices({ branches, descriptions, types: releaseTypes }),
    })
  }

  const selectedVersion = selectedReleaseBranch.replace('release/v', '')

  commandEcho.addOption('--version', selectedVersion)

  // Check if release branch exists in the list
  const prInfo = releasePRsInfo.find((pr) => {
    return pr.branch === selectedReleaseBranch
  })

  if (!prInfo) {
    logger.error(`❌ Release branch ${selectedReleaseBranch} not found in open PRs. Exiting...`)
    process.exit(1)
  }

  const releaseType: ReleaseType = detectReleaseType(prInfo.title)

  const answer = confirmedCommand
    ? true
    : await confirm({
        message: `Are you sure you want to deliver version ${selectedReleaseBranch} to production?`,
      })

  if (!confirmedCommand) {
    commandEcho.setInteractive()
  }

  if (!answer) {
    logger.info('Operation cancelled. Exiting...')
    process.exit(0)
  }

  // Track --yes flag if confirmation was interactive (user confirmed)
  commandEcho.addOption('--yes', true)

  try {
    $.quiet = true

    if (releaseType === 'hotfix') {
      // Hotfix: merge directly into main, deploy, sync back to dev
      await $`gh pr merge ${selectedReleaseBranch} --squash --admin --delete-branch`

      $.quiet = false

      await $`gh workflow run deploy-all.yml --ref main -f environment=prod`

      $.quiet = true

      // Sync main into dev
      await $`git switch main && git pull && git switch dev && git pull && git merge main --no-edit && git push`
    } else {
      // Regular: merge into dev, create RC PR to main, merge to main, deploy, sync
      await $`gh pr merge ${selectedReleaseBranch} --squash --admin --delete-branch`
      await $`gh pr create --base main --head dev --title "Release v${selectedVersion} (RC)" --body ""`
      await $`gh pr merge dev --squash --admin`

      $.quiet = false

      await $`gh workflow run deploy-all.yml --ref main -f environment=prod`

      $.quiet = true

      // Sync main into dev
      await $`git switch main && git pull && git switch dev && git pull && git merge main --no-edit && git push`
    }

    $.quiet = false

    // Deliver Jira release if Jira is configured
    const jiraConfig = await loadJiraConfigOptional()

    if (jiraConfig) {
      try {
        const versionName = selectedReleaseBranch.replace('release/', '')

        await deliverJiraRelease({ versionName }, jiraConfig)
      } catch (error) {
        logger.error({ error }, 'Failed to deliver Jira release (non-blocking)')
      }
    } else {
      logger.info('🔔 Jira is not configured, skipping Jira release delivery')
    }

    logger.info(`Successfully delivered ${selectedReleaseBranch} to production!`)

    commandEcho.print()

    const structuredContent = {
      releaseBranch: selectedReleaseBranch,
      version: selectedReleaseBranch.replace('release/v', ''),
      type: releaseType,
      success: true,
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
  } catch (error: unknown) {
    logger.error({ error }, '❌ Error merging release branch into dev')
    process.exit(1)
  }
}

// MCP Tool Registration
export const ghReleaseDeliverMcpTool = {
  name: 'gh-release-deliver',
  description:
    'Deliver a release to production. For hotfixes: squash-merges the release branch to main and dispatches the deploy-all workflow. For regular releases: squash-merges to dev, opens an RC PR, merges dev into main, dispatches the deploy-all workflow, then syncs main back to dev. Also releases the matching Jira fix version if Jira is configured. Dispatches the deploy workflow fire-and-forget — the tool returns once the workflow is accepted by GitHub, not when the deployment finishes. Irreversible production operation: the confirmation prompt is auto-skipped for MCP calls, so the caller is responsible for gating. "version" is required when invoked via MCP (the picker is unreachable without a TTY).',
  inputSchema: {
    version: z.string().describe('Release version to deliver to production (e.g., "1.2.5"). Required for MCP calls.'),
  },
  outputSchema: {
    releaseBranch: z.string().describe('The release branch that was delivered'),
    version: z.string().describe('The version that was delivered'),
    type: z.enum(['regular', 'hotfix']).describe('Release type'),
    success: z.boolean().describe('Whether the delivery was successful'),
  },
  handler: ghReleaseDeliver,
}
