import confirm from '@inquirer/confirm'
import select from '@inquirer/select'
import process from 'node:process'
import { z } from 'zod/v4'
import { question } from 'zx'

import { loadJiraConfig } from 'src/integrations/jira'
import { commandEcho } from 'src/lib/command-echo'
import { logger } from 'src/lib/logger'
import { createSingleRelease, prepareGitForRelease } from 'src/lib/release-utils'
import type { ReleaseCreationResult, ReleaseType } from 'src/lib/release-utils'
import {
  NEXT_TOKEN,
  NoPriorVersionsError,
  loadExistingVersions,
  resolveVersionTokens,
  splitVersionInput,
} from 'src/lib/version-utils'
import type { RequiredConfirmedOptionArg, ToolsExecutionResult } from 'src/types'

interface ReleaseCreateBatchArgs extends RequiredConfirmedOptionArg {
  versions: string
  type?: ReleaseType
}

const VERSIONS_PROMPT_HINT = '"1.2.5, 1.2.6", "next,next", or "next,next,1.2.7"'

/**
 * Gather and validate batch release inputs interactively if needed
 */
const resolveInputs = async (args: ReleaseCreateBatchArgs): Promise<{ versionsList: string[]; type: ReleaseType }> => {
  const { versions: inputVersions, type: inputType, confirmedCommand } = args

  let versionInput = inputVersions
  let type: ReleaseType = inputType || 'regular'

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

  if (!versionInput) {
    commandEcho.setInteractive()
    versionInput = await question(`Enter versions by comma (e.g. ${VERSIONS_PROMPT_HINT}): `)
  }

  const rawTokens = splitVersionInput(versionInput)

  if (rawTokens.length === 0) {
    logger.error('No versions provided. Exiting...')
    process.exit(1)
  }

  const needsKnown = rawTokens.some((t) => {
    return t.toLowerCase() === NEXT_TOKEN
  })
  const known = needsKnown ? await loadExistingVersions() : []

  let versionsList: string[]

  try {
    versionsList = resolveVersionTokens(rawTokens, type, known)
  } catch (err) {
    if (err instanceof NoPriorVersionsError) {
      logger.error(err.message)
      process.exit(1)
    }

    throw err
  }

  commandEcho.addOption('--versions', versionsList.join(', '))

  if (versionsList.length === 1) {
    logger.warn('💡 You are creating only one release. Consider using "create-release" command for single releases.')
  }

  const answer = confirmedCommand
    ? true
    : await confirm({
        message: `Are you sure you want to create release branches for these versions: ${versionsList.join(', ')}?`,
      })

  if (!confirmedCommand) {
    commandEcho.setInteractive()
  }

  if (!answer) {
    logger.info('Operation cancelled. Exiting...')
    process.exit(0)
  }

  commandEcho.addOption('--yes', true)

  return { versionsList, type }
}

/**
 * Create multiple release branches for the specified versions
 * Includes Jira version creation and GitHub release branch creation for each version
 */
export const releaseCreateBatch = async (args: ReleaseCreateBatchArgs): Promise<ToolsExecutionResult> => {
  commandEcho.start('release-create-batch')

  const jiraConfig = await loadJiraConfig()

  const { versionsList, type } = await resolveInputs(args)

  await prepareGitForRelease(type)

  const releases: ReleaseCreationResult[] = []
  const failedReleases: Array<{ version: string; error: string }> = []

  for (const version of versionsList) {
    try {
      // Create each release
      const release = await createSingleRelease({ version, jiraConfig, type })

      releases.push(release)

      logger.info(`✅ Successfully created release: v${version}`)
      logger.info(`🔗  GitHub PR: ${release.prUrl}`)
      logger.info(`🔗  Jira Version: ${release.jiraVersionUrl}\n`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      failedReleases.push({ version, error: errorMessage })

      logger.error(`❌ Failed to create release: v${version}`)
      logger.error(`   Error: ${errorMessage}\n`)
    }
  }

  // Final summary
  const successCount = releases.length
  const failureCount = failedReleases.length

  if (successCount === versionsList.length) {
    logger.info(`✅ All ${versionsList.length} release branches were created successfully.`)
  } else if (successCount > 0) {
    logger.warn(`⚠️  ${successCount} of ${versionsList.length} release branches were created successfully.`)
    logger.warn(`❌  ${failureCount} release(s) failed.`)
  } else {
    logger.error(`❌ All ${versionsList.length} release branches failed to create.`)
  }

  commandEcho.print()

  const structuredContent = {
    createdBranches: releases.map((r) => {
      return r.branchName
    }),
    successCount,
    failureCount,
    releases,
    failedReleases,
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
export const releaseCreateBatchMcpTool = {
  name: 'release-create-batch',
  description:
    'Create several releases in one pass: for each comma-separated version in "versions", cuts the release branch off the appropriate base (dev for regular releases, main for hotfixes), opens a GitHub PR, and creates the Jira fix version. The literal token "next" auto-increments from the latest known version (regular bumps minor + resets patch; hotfix bumps patch on the highest minor); multiple "next" tokens advance sequentially. Existing versions are unioned from remote release branches and Jira fix versions. Continues on per-version failure and reports which versions succeeded and which failed. Confirmation is auto-skipped for MCP calls, so the caller is responsible for gating. "versions" is required when invoked via MCP (the interactive input prompt is unreachable without a TTY). Use release-create for a single version with optional checkout.',
  inputSchema: {
    versions: z
      .string()
      .describe(
        'Comma-separated versions to create (e.g., "1.2.5, 1.2.6", "next,next", or "next,next,1.2.7"). Required for MCP calls.',
      ),
    type: z
      .enum(['regular', 'hotfix'])
      .optional()
      .default('regular')
      .describe('Release type: "regular" or "hotfix" (default: "regular")'),
  },
  outputSchema: {
    createdBranches: z.array(z.string()).describe('List of created release branches'),
    successCount: z.number().describe('Number of releases created successfully'),
    failureCount: z.number().describe('Number of releases that failed'),
    releases: z
      .array(
        z.object({
          version: z.string().describe('Version number'),
          type: z.enum(['regular', 'hotfix']).describe('Release type'),
          branchName: z.string().describe('Release branch name'),
          prUrl: z.string().describe('GitHub PR URL'),
          jiraVersionUrl: z.string().describe('Jira version URL'),
        }),
      )
      .describe('Detailed information for each created release with URLs'),
    failedReleases: z
      .array(
        z.object({
          version: z.string().describe('Version number that failed'),
          error: z.string().describe('Error message'),
        }),
      )
      .describe('List of releases that failed with error messages'),
  },
  handler: releaseCreateBatch,
}
