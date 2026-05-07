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
  NoPriorVersionsError,
  computeNextVersion,
  hasNextToken,
  loadExistingVersions,
  parseVersion,
  resolveReleaseEntries,
} from 'src/lib/version-utils'
import type { ReleaseEntry, SemVer } from 'src/lib/version-utils'
import type { RequiredConfirmedOptionArg, ToolsExecutionResult } from 'src/types'

interface ReleaseCreateArgs extends RequiredConfirmedOptionArg {
  releases?: ReleaseEntry[]
}

const VERSION_PROMPT_HINT = '"1.2.5" or "next"'

const trySuggestNext = (known: SemVer[], type: ReleaseType): string | null => {
  try {
    return computeNextVersion(known, type)
  } catch (err) {
    if (err instanceof NoPriorVersionsError) return null

    throw err
  }
}

const resolveOrExit = (entries: ReleaseEntry[], known: SemVer[]): ReleaseEntry[] => {
  try {
    return resolveReleaseEntries(entries, known)
  } catch (err) {
    if (err instanceof NoPriorVersionsError) {
      logger.error(err.message)
      process.exit(1)
    }

    throw err
  }
}

const promptForReleasesInteractive = async (ensureKnown: () => Promise<SemVer[]>): Promise<ReleaseEntry[]> => {
  commandEcho.setInteractive()

  const baseKnown = await ensureKnown()
  const running: SemVer[] = [...baseKnown]
  const entries: ReleaseEntry[] = []
  let addAnother = true

  while (addAnother) {
    const ordinal = entries.length + 1
    const type = await select<ReleaseType>({
      message: `Release #${ordinal} — select type:`,
      choices: [
        { name: 'regular', value: 'regular' },
        { name: 'hotfix', value: 'hotfix' },
      ],
      default: 'regular',
    })

    const suggestion = trySuggestNext(running, type)
    const defaultHint = suggestion ? ` [${suggestion}]` : ''
    const versionAnswer = (await question(`  Version (e.g. ${VERSION_PROMPT_HINT})${defaultHint}: `)).trim()
    const versionInput = versionAnswer === '' ? (suggestion ?? '') : versionAnswer

    if (versionInput === '') {
      logger.error('No version provided. Exiting...')
      process.exit(1)
    }

    const resolved = resolveOrExit([{ version: versionInput, type }], running)[0] as ReleaseEntry

    running.push(parseVersion(`v${resolved.version}`))

    const description = (await question('  Description (optional, press Enter to skip): ')).trim()

    entries.push({ ...resolved, ...(description !== '' ? { description } : {}) })

    addAnother = await confirm({ message: 'Add another release?', default: false })
  }

  return entries
}

const formatReleaseSummary = (entry: ReleaseEntry): string => {
  const parts = [`v${entry.version}`, entry.type]

  if (entry.description) parts.push(entry.description)

  return parts.join(' · ')
}

const echoReleases = (entries: ReleaseEntry[]): void => {
  for (const entry of entries) {
    const spec = entry.description
      ? `${entry.version}:${entry.type}:${entry.description}`
      : `${entry.version}:${entry.type}`

    commandEcho.addOption('--release', spec)
  }
}

interface FailedRelease {
  version: string
  error: string
}

const collectEntries = async (
  inputReleases: ReleaseEntry[] | undefined,
  ensureKnown: () => Promise<SemVer[]>,
): Promise<ReleaseEntry[]> => {
  if (inputReleases && inputReleases.length > 0) {
    const known = hasNextToken(inputReleases) ? await ensureKnown() : []
    const resolved = resolveOrExit(inputReleases, known)

    echoReleases(resolved)

    return resolved
  }

  const interactive = await promptForReleasesInteractive(ensureKnown)

  echoReleases(interactive)

  return interactive
}

const confirmReleases = async (entries: ReleaseEntry[], confirmedCommand: boolean): Promise<void> => {
  const summary = entries.map(formatReleaseSummary).join('\n  - ')
  const answer = confirmedCommand
    ? true
    : await confirm({
        message: `Create the following ${entries.length} release(s)?\n  - ${summary}\n`,
      })

  if (!confirmedCommand) {
    commandEcho.setInteractive()
  }

  if (!answer) {
    logger.info('Operation cancelled. Exiting...')
    process.exit(0)
  }

  commandEcho.addOption('--yes', true)
}

interface ExecuteOneArgs {
  entry: ReleaseEntry
  jiraConfig: Awaited<ReturnType<typeof loadJiraConfig>>
}

const executeOne = async (
  args: ExecuteOneArgs,
): Promise<{ result?: ReleaseCreationResult; failure?: FailedRelease }> => {
  const { entry, jiraConfig } = args

  try {
    await prepareGitForRelease(entry.type)

    const result = await createSingleRelease({
      version: entry.version,
      jiraConfig,
      description: entry.description,
      type: entry.type,
    })

    logger.info(`✅ Successfully created release: v${entry.version} (${entry.type})`)
    logger.info(`🔗  GitHub PR: ${result.prUrl}`)
    logger.info(`🔗  Jira Version: ${result.jiraVersionUrl}\n`)

    return { result }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    logger.error(`❌ Failed to create release: v${entry.version}`)
    logger.error(`   Error: ${errorMessage}\n`)

    return { failure: { version: entry.version, error: errorMessage } }
  }
}

const logFinalSummary = (total: number, successCount: number, failureCount: number): void => {
  if (successCount === total) {
    logger.info(`✅ All ${total} release branch(es) were created successfully.`)
  } else if (successCount > 0) {
    logger.warn(`⚠️  ${successCount} of ${total} release branches were created successfully.`)
    logger.warn(`❌  ${failureCount} release(s) failed.`)
  } else {
    logger.error(`❌ All ${total} release branch(es) failed to create.`)
  }
}

/**
 * Create one or more release branches. Each release carries its own type
 * (regular/hotfix) and optional Jira description, so a single invocation
 * may mix regular and hotfix releases off their respective base branches.
 */
export const releaseCreate = async (args: ReleaseCreateArgs): Promise<ToolsExecutionResult> => {
  const { releases: inputReleases, confirmedCommand } = args

  commandEcho.start('release-create')

  const jiraConfig = await loadJiraConfig()

  let known: SemVer[] | null = null
  const ensureKnown = async (): Promise<SemVer[]> => {
    if (known === null) known = await loadExistingVersions()

    return known
  }

  const entries = await collectEntries(inputReleases, ensureKnown)

  if (entries.length === 0) {
    logger.error('No releases provided. Exiting...')
    process.exit(1)
  }

  await confirmReleases(entries, Boolean(confirmedCommand))

  const created: ReleaseCreationResult[] = []
  const failed: FailedRelease[] = []

  for (const entry of entries) {
    const { result, failure } = await executeOne({ entry, jiraConfig })

    if (result) created.push(result)
    if (failure) failed.push(failure)
  }

  logFinalSummary(entries.length, created.length, failed.length)

  commandEcho.print()

  const structuredContent = {
    createdBranches: created.map((r) => {
      return r.branchName
    }),
    successCount: created.length,
    failureCount: failed.length,
    releases: created,
    failedReleases: failed,
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
    'Create one or more releases in a single call. Each entry in "releases" carries its own version, type (regular|hotfix, default regular), and optional description, so regular and hotfix releases can be mixed in the same invocation. For each release this tool switches to the appropriate base branch (dev for regular, main for hotfix), cuts the release branch, opens a GitHub release PR, and creates the matching Jira fix version. The literal token "next" auto-increments from the union of remote release branches and Jira fix versions (regular bumps minor + resets patch; hotfix bumps patch on the highest minor); multiple "next" tokens advance sequentially across mixed types. Confirmation is auto-skipped for MCP calls, so the caller is responsible for gating. Continues on per-release failure and reports successes/failures.',
  inputSchema: {
    releases: z
      .array(
        z.object({
          version: z
            .string()
            .describe('Version to create (e.g., "1.2.5") or the literal token "next" for auto-increment.'),
          type: z
            .enum(['regular', 'hotfix'])
            .optional()
            .default('regular')
            .describe('Release type: "regular" (branches off dev) or "hotfix" (branches off main).'),
          description: z.string().optional().describe('Optional description for the Jira version.'),
        }),
      )
      .min(1)
      .describe('One or more releases to create. Each entry has its own version, type, and optional description.'),
  },
  outputSchema: {
    createdBranches: z.array(z.string()).describe('List of created release branch names'),
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
  handler: releaseCreate,
}
