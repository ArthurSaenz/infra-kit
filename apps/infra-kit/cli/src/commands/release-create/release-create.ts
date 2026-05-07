import confirm from '@inquirer/confirm'
import select from '@inquirer/select'
import process from 'node:process'
import { z } from 'zod/v4'
import { question } from 'zx'

import { loadJiraConfig } from 'src/integrations/jira'
import { commandEcho } from 'src/lib/command-echo'
import { logger } from 'src/lib/logger'
import { createSingleRelease, prepareGitForRelease } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import {
  NEXT_TOKEN,
  NoPriorVersionsError,
  computeNextVersion,
  loadExistingVersions,
  resolveVersionTokens,
  splitVersionInput,
} from 'src/lib/version-utils'
import type { SemVer } from 'src/lib/version-utils'
import type { RequiredConfirmedOptionArg, ToolsExecutionResult } from 'src/types'

import { releaseCreateBatch } from '../release-create-batch/release-create-batch'

interface ReleaseCreateArgs extends RequiredConfirmedOptionArg {
  version?: string
  description?: string
  type?: ReleaseType
}

const VERSION_PROMPT_HINT = '"1.2.5", "next", or "next,next,1.2.7"'

const promptForType = async (): Promise<ReleaseType> => {
  commandEcho.setInteractive()

  return select<ReleaseType>({
    message: 'Select release type:',
    choices: [
      { name: 'regular', value: 'regular' },
      { name: 'hotfix', value: 'hotfix' },
    ],
    default: 'regular',
  })
}

const trySuggestNext = (known: SemVer[], type: ReleaseType): string | null => {
  try {
    return computeNextVersion(known, type)
  } catch (err) {
    if (err instanceof NoPriorVersionsError) return null

    throw err
  }
}

const exitOnNoPrior = (err: unknown): never => {
  if (err instanceof NoPriorVersionsError) {
    logger.error(err.message)
    process.exit(1)
  }

  throw err
}

interface ResolveTokensArgs {
  inputVersion: string | undefined
  type: ReleaseType
  ensureKnown: () => Promise<SemVer[]>
}

const resolveRawTokens = async (args: ResolveTokensArgs): Promise<string[]> => {
  const { inputVersion, type, ensureKnown } = args

  if (inputVersion && inputVersion.trim() !== '') {
    return splitVersionInput(inputVersion)
  }

  commandEcho.setInteractive()

  const suggestion = trySuggestNext(await ensureKnown(), type)
  const defaultHint = suggestion ? ` [${suggestion}]` : ''
  const answer = (await question(`Enter version(s) (e.g. ${VERSION_PROMPT_HINT})${defaultHint}: `)).trim()

  if (answer === '') return suggestion ? [suggestion] : []

  return splitVersionInput(answer)
}

const resolveVersionList = async (args: ResolveTokensArgs): Promise<string[]> => {
  const rawTokens = await resolveRawTokens(args)

  if (rawTokens.length === 0) {
    logger.error('No version provided. Exiting...')
    process.exit(1)
  }

  const needsKnown = rawTokens.some((t) => {
    return t.toLowerCase() === NEXT_TOKEN
  })

  try {
    return resolveVersionTokens(rawTokens, args.type, needsKnown ? await args.ensureKnown() : [])
  } catch (err) {
    return exitOnNoPrior(err)
  }
}

const resolveDescription = async (input: string | undefined): Promise<string> => {
  if (input !== undefined) return input

  commandEcho.setInteractive()
  const answer = await question('Enter description (optional, press Enter to skip): ')

  return answer.trim()
}

/**
 * Create a single release branch for the specified version
 * Includes Jira version creation and GitHub release branch creation
 */
export const releaseCreate = async (args: ReleaseCreateArgs): Promise<ToolsExecutionResult> => {
  const { version: inputVersion, description: inputDescription, type: inputType, confirmedCommand } = args

  commandEcho.start('release-create')

  // Load Jira config - it is now mandatory
  const jiraConfig = await loadJiraConfig()

  const type: ReleaseType = inputType ?? (await promptForType())

  commandEcho.addOption('--type', type)

  let known: SemVer[] | null = null
  const ensureKnown = async (): Promise<SemVer[]> => {
    if (known === null) known = await loadExistingVersions()

    return known
  }

  const resolvedVersions = await resolveVersionList({ inputVersion, type, ensureKnown })

  if (resolvedVersions.length > 1) {
    logger.info(`Detected ${resolvedVersions.length} versions, routing to release-create-batch...`)

    return releaseCreateBatch({
      versions: resolvedVersions.join(','),
      type,
      confirmedCommand,
    })
  }

  const trimmedVersion = resolvedVersions[0] as string

  commandEcho.addOption('--version', trimmedVersion)

  const description = await resolveDescription(inputDescription)

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

  const release = await createSingleRelease({ version: trimmedVersion, jiraConfig, description, type })

  logger.info(`✅ Successfully created release: v${trimmedVersion}`)
  logger.info(`🔗  GitHub PR: ${release.prUrl}`)
  logger.info(`🔗  Jira Version: ${release.jiraVersionUrl}`)

  commandEcho.print()

  const structuredContent = {
    version: trimmedVersion,
    type,
    branchName: release.branchName,
    prUrl: release.prUrl,
    jiraVersionUrl: release.jiraVersionUrl,
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
    'Create a new release: cuts the release branch off the appropriate base (dev for regular releases, main for hotfixes), opens a GitHub release PR, and creates the matching Jira fix version. Does not switch the working tree to the new branch — the caller stays on the base branch. Confirmation is auto-skipped for MCP calls, so the caller is responsible for gating. "version" is required when invoked via MCP (the interactive input prompt is unreachable without a TTY); pass "next" to auto-compute the next version (regular bumps minor + resets patch; hotfix bumps patch on the highest minor) using the union of remote release branches and Jira fix versions. "type" / "description" default to regular / empty when omitted. For multiple versions in one call, prefer release-create-batch.',
  inputSchema: {
    version: z
      .string()
      .describe(
        'Version to create (e.g., "1.2.5") or the literal token "next" for auto-increment. Required for MCP calls.',
      ),
    description: z.string().optional().describe('Optional description for the Jira version'),
    type: z
      .enum(['regular', 'hotfix'])
      .optional()
      .default('regular')
      .describe('Release type: "regular" or "hotfix" (default: "regular")'),
  },
  outputSchema: {
    version: z.string().describe('Version number'),
    type: z.enum(['regular', 'hotfix']).describe('Release type'),
    branchName: z.string().describe('Release branch name'),
    prUrl: z.string().describe('GitHub PR URL'),
    jiraVersionUrl: z.string().describe('Jira version URL'),
  },
  handler: releaseCreate,
}
