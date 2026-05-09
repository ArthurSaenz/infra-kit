import confirm from '@inquirer/confirm'
import select from '@inquirer/select'
import process from 'node:process'
import { z } from 'zod/v4'
import { question } from 'zx'

import { getReleasePRsWithInfo, updateReleasePRBody } from 'src/integrations/gh'
import { findVersionByName, loadJiraConfig, updateJiraVersion } from 'src/integrations/jira'
import type { JiraConfig, JiraVersion } from 'src/integrations/jira'
import { commandEcho } from 'src/lib/command-echo'
import { logger } from 'src/lib/logger'
import { detectReleaseType, formatBranchChoices, getJiraDescriptions } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import type { RequiredConfirmedOptionArg, ToolsExecutionResult } from 'src/types'

interface ReleaseDescEditArgs extends Partial<RequiredConfirmedOptionArg> {
  version?: string
  description?: string
}

const buildJiraVersionUrl = (jiraConfig: JiraConfig, version: JiraVersion): string => {
  return `${jiraConfig.baseUrl}/projects/${version.projectId}/versions/${version.id}/tab/release-report-all-issues`
}

const buildPRBody = (jiraVersionUrl: string, description: string): string => {
  return description.trim() !== '' ? `${jiraVersionUrl}\n\n${description}` : `${jiraVersionUrl} \n`
}

const pickReleaseBranch = async (): Promise<{ branch: string; type: ReleaseType }> => {
  const releasePRsInfo = await getReleasePRsWithInfo()
  const branches = releasePRsInfo.map((pr) => {
    return pr.branch
  })
  const types = new Map<string, ReleaseType>(
    releasePRsInfo.map((pr) => {
      return [pr.branch, detectReleaseType(pr.title)]
    }),
  )
  const descriptions = await getJiraDescriptions()

  const branch = await select({
    message: '🌿 Select release branch',
    choices: formatBranchChoices({ branches, descriptions, types }),
  })

  return { branch, type: types.get(branch) || 'regular' }
}

const verifyReleasePRExists = async (selectedBranch: string): Promise<ReleaseType> => {
  const releasePRsInfo = await getReleasePRsWithInfo()
  const prInfo = releasePRsInfo.find((pr) => {
    return pr.branch === selectedBranch
  })

  if (!prInfo) {
    logger.error(`❌ Release branch ${selectedBranch} not found in open PRs. Exiting...`)
    process.exit(1)
  }

  return detectReleaseType(prInfo.title)
}

const promptDescription = async (current: string): Promise<string> => {
  const hint = current === '' ? '(no current description)' : `current: "${current}"`
  const answer = await question(`  New description ${hint}\n  (press Enter to keep current): `)
  const trimmed = answer.replace(/\n$/, '')

  return trimmed === '' ? current : trimmed
}

/**
 * Edit a release's description in Jira (fix version) and in the matching
 * GitHub release PR body. The PR body is rewritten canonically to
 * `<jiraVersionUrl>\n\n<description>` (matching `release-create`).
 */
export const releaseDescEdit = async (args: ReleaseDescEditArgs): Promise<ToolsExecutionResult> => {
  const { version: versionArg, description: descriptionArg, confirmedCommand } = args

  commandEcho.start('release-desc-edit')

  const jiraConfig = await loadJiraConfig()

  let selectedBranch: string

  if (versionArg) {
    selectedBranch = `release/v${versionArg}`
    await verifyReleasePRExists(selectedBranch)
  } else {
    commandEcho.setInteractive()
    const picked = await pickReleaseBranch()

    selectedBranch = picked.branch
  }

  const selectedVersion = selectedBranch.replace('release/v', '')

  commandEcho.addOption('--version', selectedVersion)

  const versionName = `v${selectedVersion}`
  const jiraVersion = await findVersionByName(versionName, jiraConfig)

  if (!jiraVersion) {
    logger.error(`❌ Jira version "${versionName}" not found. Exiting...`)
    process.exit(1)
  }

  const previousDescription = jiraVersion.description ?? ''

  let newDescription: string

  if (descriptionArg !== undefined) {
    newDescription = descriptionArg
    commandEcho.addOption('--description', newDescription)
  } else {
    commandEcho.setInteractive()
    newDescription = await promptDescription(previousDescription)
  }

  if (newDescription === previousDescription) {
    logger.info(`No change — description for ${versionName} is already: "${previousDescription}"`)
    commandEcho.print()

    const structuredContent = {
      version: selectedVersion,
      branch: selectedBranch,
      jiraVersionUrl: buildJiraVersionUrl(jiraConfig, jiraVersion),
      previousDescription,
      newDescription,
      changed: false,
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    }
  }

  const answer = confirmedCommand
    ? true
    : await confirm({
        message: `Update description for ${versionName}?\n  from: "${previousDescription}"\n  to:   "${newDescription}"\n`,
      })

  if (!confirmedCommand) {
    commandEcho.setInteractive()
  }

  if (!answer) {
    logger.info('Operation cancelled. Exiting...')
    process.exit(0)
  }

  commandEcho.addOption('--yes', true)

  await updateJiraVersion({ versionId: jiraVersion.id, description: newDescription }, jiraConfig)

  const jiraVersionUrl = buildJiraVersionUrl(jiraConfig, jiraVersion)
  const body = buildPRBody(jiraVersionUrl, newDescription)

  await updateReleasePRBody({ branch: selectedBranch, body })

  logger.info(`✅ Updated description for ${versionName}`)
  logger.info(`🔗  Jira Version: ${jiraVersionUrl}`)
  logger.info(`🔗  PR branch: ${selectedBranch}\n`)

  commandEcho.print()

  const structuredContent = {
    version: selectedVersion,
    branch: selectedBranch,
    jiraVersionUrl,
    previousDescription,
    newDescription,
    changed: true,
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  }
}

// MCP Tool Registration
export const releaseDescEditMcpTool = {
  name: 'release-desc-edit',
  description:
    "Edit a release's description in Jira and in the matching GitHub release PR body. Targets the Jira fix version named `v<version>` and the open PR on branch `release/v<version>`. The PR body is rewritten canonically to `<jiraVersionUrl>\\n\\n<description>` — any prior manual edits to the body are overwritten. Both `version` and `description` are required for MCP calls (the picker/prompt are unreachable without a TTY). Empty `description` clears the description on both sides. Confirmation is auto-skipped for MCP, so the caller is responsible for gating.",
  inputSchema: {
    version: z.string().describe('Release version, e.g. "1.2.5".'),
    description: z.string().describe('New description. Empty string clears the description.'),
  },
  outputSchema: {
    version: z.string().describe('Release version'),
    branch: z.string().describe('Release branch name (e.g. "release/v1.2.5")'),
    jiraVersionUrl: z.string().describe('Jira fix version URL'),
    previousDescription: z.string().describe('The description before the update'),
    newDescription: z.string().describe('The description after the update'),
    changed: z.boolean().describe('Whether the description actually changed'),
  },
  handler: releaseDescEdit,
}
