import input from '@inquirer/input'
import { z } from 'zod'

import { getReleasePRsWithInfo, updateReleasePRBody } from 'src/integrations/gh'
import { findVersionByName, loadJiraConfig, updateJiraVersion } from 'src/integrations/jira'
import type { JiraConfig, JiraVersion } from 'src/integrations/jira'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { logger } from 'src/lib/logger'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { pickReleaseBranch as pickReleaseBranchPrompt } from 'src/lib/prompts/release-picker'
import { displayLabel, formatJiraName, parseBranchName } from 'src/lib/release-id'
import {
  detectReleaseType,
  formatBranchPickerItems,
  getJiraDescriptions,
  resolveReleaseBranch,
} from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

interface ReleaseDescEditArgs extends RequiredConfirmedOptionArg {
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

  const branch = await pickReleaseBranchPrompt(formatBranchPickerItems({ branches, descriptions, types }))

  return { branch, type: types.get(branch) || 'regular' }
}

const verifyReleasePRExists = async (selectedBranch: string): Promise<ReleaseType> => {
  const releasePRsInfo = await getReleasePRsWithInfo()
  const prInfo = releasePRsInfo.find((pr) => {
    return pr.branch === selectedBranch
  })

  if (!prInfo) {
    throw new OperationError(undefined, {
      operation: `edit description for ${selectedBranch}`,
      remediation: `confirm an open PR exists for ${selectedBranch} ('gh pr list')`,
    })
  }

  return detectReleaseType(prInfo.title)
}

/**
 * Exported for test only. The keep-current semantics below turn on exactly how the answer is
 * whitespace-normalised, which is the detail that changed when this stopped being a zx `question`.
 */
export const promptDescription = async (current: string): Promise<string> => {
  const hint = current === '' ? '(no current description)' : `current: "${current}"`
  // SINGLE-LINE message on purpose. The hint used to sit on its own line via an embedded `\n`,
  // which zx wrote raw and inquirer cannot: inquirer re-renders on every keystroke and derives
  // its ANSI erase-line count from the rendered message, so a manual newline miscounts and
  // leaves orphaned prompt fragments on screen. Inlining the hint removes the hazard outright
  // rather than testing around it.
  const answer = await withEscape((context) => {
    return input({ message: `  New description ${hint} (press Enter to keep current): ` }, context)
  })
  // `.trim()`, where the zx version only stripped a trailing newline. Whitespace-only input now
  // means keep-current instead of overwriting the description with blanks.
  const trimmed = answer.trim()

  return trimmed === '' ? current : trimmed
}

/**
 * Edit a release's description in Jira (fix version) and in the matching
 * GitHub release PR body. The PR body is rewritten canonically to
 * `<jiraVersionUrl>\n\n<description>` (matching `release-create`).
 */
export const releaseDescEdit = async (args: ReleaseDescEditArgs) => {
  const { version: versionArg, description: descriptionArg, confirmedCommand } = args

  const jiraConfig = await loadJiraConfig()

  let selectedBranch: string

  if (versionArg) {
    selectedBranch = resolveReleaseBranch(versionArg)
    await verifyReleasePRExists(selectedBranch)
  } else {
    commandEcho.setInteractive()
    const picked = await pickReleaseBranch()

    selectedBranch = picked.branch
  }

  // selectedBranch is always a release branch here (operator ref strictly parsed,
  // or picked from discovery-filtered choices), so parseBranchName cannot be null.
  const releaseId = parseBranchName(selectedBranch)

  if (!releaseId) {
    throw new OperationError(undefined, {
      operation: `edit description for ${selectedBranch}`,
      remediation: 'pass a version (e.g. "1.2.5") or a release name (e.g. "checkout-redesign")',
    })
  }

  const selectedVersion = displayLabel(releaseId)

  commandEcho.addOption('--version', selectedVersion)

  // Jira fix version is named by the Jira convention: `v1.2.3` | `<name>`.
  const versionName = formatJiraName(releaseId)
  const jiraVersion = await findVersionByName(versionName, jiraConfig)

  if (!jiraVersion) {
    throw new OperationError(undefined, {
      operation: `edit description for ${versionName}`,
      remediation: `create the Jira fix version "${versionName}" first or pick a different release`,
    })
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

  const buildResult = (changed: boolean) => {
    const structuredContent = {
      version: selectedVersion,
      branch: selectedBranch,
      jiraVersionUrl: buildJiraVersionUrl(jiraConfig, jiraVersion),
      previousDescription,
      newDescription,
      changed,
    }

    return {
      content: textContent(JSON.stringify(structuredContent, null, 2)),
      structuredContent,
    }
  }

  if (newDescription === previousDescription) {
    logger.info(`No change — description for ${versionName} is already: "${previousDescription}"`)
    commandEcho.print()

    return buildResult(false)
  }

  await confirmOrExit(
    confirmedCommand,
    `Update description for ${versionName}?\n  from: "${previousDescription}"\n  to:   "${newDescription}"\n`,
  )

  commandEcho.addOption('--yes', true)

  await updateJiraVersion({ versionId: jiraVersion.id, description: newDescription }, jiraConfig)

  const jiraVersionUrl = buildJiraVersionUrl(jiraConfig, jiraVersion)
  const body = buildPRBody(jiraVersionUrl, newDescription)

  await updateReleasePRBody({ branch: selectedBranch, body })

  logger.info(`✅ Updated description for ${versionName}`)
  logger.info(`🔗  Jira Version: ${jiraVersionUrl}`)
  logger.info(`🔗  PR branch: ${selectedBranch}\n`)

  commandEcho.print()

  return buildResult(true)
}

// MCP Tool Registration
export const releaseDescEditMcpTool = defineMcpTool({
  name: 'release-desc-edit',
  description:
    "Edit a release's description in Jira and in the matching GitHub release PR body. Accepts a release version or a release name: targets the Jira fix version named `v<version>` (versioned) or `<name>` (named) and the open PR on branch `release/v<version>` or `release/<name>`. The PR body is rewritten canonically to `<jiraVersionUrl>\\n\\n<description>` — any prior manual edits to the body are overwritten. Both `version` and `description` are required for MCP calls (the picker/prompt are unreachable without a TTY). Empty `description` clears the description on both sides. Confirmation is auto-skipped for MCP, so the caller is responsible for gating.",
  inputSchema: {
    version: z
      .string()
      .describe('Accepts a release version (e.g. "1.2.5") OR a release name (e.g. "checkout-redesign").'),
    description: z.string().describe('New description. Empty string clears the description.'),
  },
  outputSchema: {
    version: z.string().describe('Release version'),
    branch: z.string().describe('Release branch name (e.g. "release/v1.2.5" or "release/checkout-redesign")'),
    jiraVersionUrl: z.string().describe('Jira fix version URL'),
    previousDescription: z.string().describe('The description before the update'),
    newDescription: z.string().describe('The description after the update'),
    changed: z.boolean().describe('Whether the description actually changed'),
  },
  handler: releaseDescEdit,
})
