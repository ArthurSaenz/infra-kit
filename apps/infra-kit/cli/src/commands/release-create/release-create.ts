import confirm from '@inquirer/confirm'
import select from '@inquirer/select'
import process from 'node:process'
import { z } from 'zod'
import { $, question } from 'zx'

import { loadJiraConfig } from 'src/integrations/jira'
import { commandEcho } from 'src/lib/command-echo'
import { logger } from 'src/lib/logger'
import { createSingleRelease, prepareGitForRelease } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import type { RequiredConfirmedOptionArg, ToolsExecutionResult } from 'src/types'

interface ReleaseCreateArgs extends RequiredConfirmedOptionArg {
  version?: string
  description?: string
  type?: ReleaseType
  checkout?: boolean
}

/**
 * Create a single release branch for the specified version
 * Includes Jira version creation and GitHub release branch creation
 */
export const releaseCreate = async (args: ReleaseCreateArgs): Promise<ToolsExecutionResult> => {
  const {
    version: inputVersion,
    description: inputDescription,
    type: inputType,
    confirmedCommand,
    checkout: inputCheckout,
  } = args

  commandEcho.start('release-create')

  let version = inputVersion
  let description = inputDescription
  let type: ReleaseType = inputType || 'regular'
  let checkout = inputCheckout

  // Load Jira config - it is now mandatory
  const jiraConfig = await loadJiraConfig()

  if (!version) {
    commandEcho.setInteractive()
    version = await question('Enter version (e.g. 1.2.5): ')
  }

  // Validate input (validate the version is a valid semver)
  if (!version || version.trim() === '') {
    logger.error('No version provided. Exiting...')
    process.exit(1)
  }

  const trimmedVersion = version.trim()

  commandEcho.addOption('--version', trimmedVersion)

  if (!inputType) {
    commandEcho.setInteractive()

    type = await select<ReleaseType>({
      message: 'Select release type:',
      choices: [
        { name: 'regular', value: 'regular' },
        { name: 'hotfix', value: 'hotfix' },
      ],
      default: 'regular',
    })
  }

  commandEcho.addOption('--type', type)

  if (description === undefined) {
    commandEcho.setInteractive()
    description = await question('Enter description (optional, press Enter to skip): ')

    if (description.trim() === '') {
      description = ''
    }
  }

  if (description) {
    commandEcho.addOption('--description', description)
  }

  const answer = confirmedCommand
    ? true
    : await confirm({
        message: `Are you sure you want to create release branch for version ${trimmedVersion}?`,
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

  await prepareGitForRelease(type)

  // Create the release
  const release = await createSingleRelease({ version: trimmedVersion, jiraConfig, description, type })

  logger.info(`✅ Successfully created release: v${trimmedVersion}`)
  logger.info(`🔗  GitHub PR: ${release.prUrl}`)
  logger.info(`🔗  Jira Version: ${release.jiraVersionUrl}`)

  // Ask about checkout if not specified
  if (checkout === undefined) {
    commandEcho.setInteractive()

    checkout = await confirm({
      message: `Do you want to checkout to the created branch ${release.branchName}?`,
      default: true,
    })
  }

  // Track checkout option (--no-checkout if false)
  if (!checkout) {
    commandEcho.addOption('--no-checkout', true)
  }

  // Checkout to the created branch by default
  if (checkout) {
    $.quiet = true
    await $`git switch ${release.branchName}`
    $.quiet = false

    logger.info(`🔄 Switched to branch ${release.branchName}`)
  }

  commandEcho.print()

  const structuredContent = {
    version: trimmedVersion,
    type,
    branchName: release.branchName,
    prUrl: release.prUrl,
    jiraVersionUrl: release.jiraVersionUrl,
    isCheckedOut: checkout,
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

// MCP Tool Registration
export const releaseCreateMcpTool = {
  name: 'release-create',
  description:
    'Create a new release: cuts the release branch off the appropriate base (dev for regular releases, main for hotfixes), opens a GitHub release PR, creates the matching Jira fix version, and optionally checks out to the new branch. Confirmation is auto-skipped for MCP calls, so the caller is responsible for gating. "version" is required when invoked via MCP (the interactive input prompt is unreachable without a TTY); "type" / "description" / "checkout" default to regular / empty / true when omitted.',
  inputSchema: {
    version: z.string().describe('Version to create (e.g., "1.2.5"). Required for MCP calls.'),
    description: z.string().optional().describe('Optional description for the Jira version'),
    type: z
      .enum(['regular', 'hotfix'])
      .optional()
      .default('regular')
      .describe('Release type: "regular" or "hotfix" (default: "regular")'),
    checkout: z.boolean().optional().default(true).describe('Checkout to the created branch (default: true)'),
  },
  outputSchema: {
    version: z.string().describe('Version number'),
    type: z.enum(['regular', 'hotfix']).describe('Release type'),
    branchName: z.string().describe('Release branch name'),
    prUrl: z.string().describe('GitHub PR URL'),
    jiraVersionUrl: z.string().describe('Jira version URL'),
    isCheckedOut: z.boolean().describe('Whether the branch was checked out'),
  },
  handler: releaseCreate,
}
