import confirm from '@inquirer/confirm'
import select from '@inquirer/select'
import process from 'node:process'
import { z } from 'zod'
import { question } from 'zx'

import { loadJiraConfig } from 'src/integrations/jira'
import { commandEcho } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { logger } from 'src/lib/logger'
import { InvalidReleaseNameError, displayLabel, validateName } from 'src/lib/release-id'
import { createSingleRelease, getBaseBranch, prepareGitForRelease } from 'src/lib/release-utils'
import type { ReleaseCreationResult, ReleaseType } from 'src/lib/release-utils'
import {
  NoPriorVersionsError,
  computeNextVersion,
  formatReleaseSpec,
  hasNextToken,
  loadExistingVersions,
  parseVersion,
  resolveReleaseEntries,
} from 'src/lib/version-utils'
import type { ReleaseEntry, ReleaseInput, SemVer } from 'src/lib/version-utils'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

interface ReleaseCreateArgs extends RequiredConfirmedOptionArg {
  releases?: ReleaseInput[]
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

const resolveOrExit = (entries: ReleaseInput[], known: SemVer[]): ReleaseEntry[] => {
  try {
    return resolveReleaseEntries(entries, known)
  } catch (err) {
    if (err instanceof NoPriorVersionsError) {
      throw new OperationError(err, {
        operation: 'resolve release version',
        remediation: 'pass an explicit version (e.g. "1.2.5") instead of "next" when there are no prior versions',
      })
    }

    if (err instanceof InvalidReleaseNameError) {
      throw new OperationError(err, {
        operation: 'validate release name',
        remediation:
          'use a kebab-case name like "checkout-redesign" (lowercase, digits, single hyphens, not a reserved word)',
      })
    }

    throw err
  }
}

const promptForVersionInput = async (running: SemVer[], type: ReleaseType): Promise<string> => {
  const suggestion = trySuggestNext(running, type)
  const defaultHint = suggestion ? ` [${suggestion}]` : ''
  const versionAnswer = (await question(`  Version (e.g. ${VERSION_PROMPT_HINT})${defaultHint}: `)).trim()
  const versionInput = versionAnswer === '' ? (suggestion ?? '') : versionAnswer

  if (versionInput === '') {
    logger.error('No version provided. Exiting...')
    process.exit(1)
  }

  return versionInput
}

const promptForNameInput = async (): Promise<string> => {
  const name = (await question('  Name (kebab-case, e.g. "checkout-redesign"): ')).trim()

  if (name === '') {
    logger.error('No name provided. Exiting...')
    process.exit(1)
  }

  try {
    validateName(name)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)

    logger.error(`${reason} Exiting...`)
    process.exit(1)
  }

  return name
}

const promptForReleasesInteractive = async (ensureKnown: () => Promise<SemVer[]>): Promise<ReleaseEntry[]> => {
  commandEcho.setInteractive()

  let baseKnown: SemVer[] | null = null
  const running: SemVer[] = []
  const ensureRunning = async (): Promise<SemVer[]> => {
    if (baseKnown === null) {
      baseKnown = await ensureKnown()
      running.push(...baseKnown)
    }

    return running
  }

  const entries: ReleaseEntry[] = []
  let addAnother = true

  while (addAnother) {
    const ordinal = entries.length + 1
    const kind = await select<'version' | 'name'>({
      message: `Release #${ordinal} — version or name?`,
      choices: [
        { name: 'version (semver / next)', value: 'version' },
        { name: 'name (free-form)', value: 'name' },
      ],
      default: 'version',
    })

    const type = await select<ReleaseType>({
      message: `Release #${ordinal} — select type:`,
      choices: [
        { name: 'regular', value: 'regular' },
        { name: 'hotfix', value: 'hotfix' },
      ],
      default: 'regular',
    })

    let resolved: ReleaseEntry

    if (kind === 'name') {
      const name = await promptForNameInput()

      resolved = resolveOrExit([{ name, type }], [])[0] as ReleaseEntry
    } else {
      // Versions may need prior versions for "next"; load lazily.
      const versionInput = await promptForVersionInput(await ensureRunning(), type)

      resolved = resolveOrExit([{ version: versionInput, type }], running)[0] as ReleaseEntry

      if (resolved.id.kind === 'version') {
        running.push(parseVersion(`v${resolved.id.raw}`))
      }
    }

    const description = (await question('  Description (optional, press Enter to skip): ')).trim()

    entries.push({ ...resolved, ...(description !== '' ? { description } : {}) })

    addAnother = await confirm({ message: 'Add another release?', default: false })
  }

  return entries
}

const formatReleaseSummary = (entry: ReleaseEntry): string => {
  const label = entry.id.kind === 'version' ? `v${entry.id.raw}` : entry.id.name
  const parts = [label, entry.type]

  if (entry.description) parts.push(entry.description)

  return parts.join(' · ')
}

const echoReleases = (entries: ReleaseEntry[]): void => {
  // Every entry — versions, "next" (resolved to a concrete version), and named
  // releases alike — echoes through the single --release flag. formatReleaseSpec
  // produces a spec that parseReleaseSpec parses back into the same entry.
  for (const entry of entries) {
    commandEcho.addOption('--release', formatReleaseSpec(entry))
  }
}

interface FailedRelease {
  version: string
  error: string
}

const collectEntries = async (
  inputReleases: ReleaseInput[] | undefined,
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

/**
 * Reject a batch that mixes regular and hotfix releases. They branch off
 * different bases (dev vs main), so the batch has no single required branch for
 * the management guard — they must be created in separate invocations.
 * Exported for unit testing without running the side-effecting handler.
 */
export const assertHomogeneousReleaseType = (entries: ReleaseEntry[]): void => {
  const types = new Set(
    entries.map((entry) => {
      return entry.type
    }),
  )

  if (types.size > 1) {
    throw new OperationError(undefined, {
      operation: 'create release',
      remediation: 'create regular and hotfix releases in separate invocations',
      stderrExcerpt: 'mixed regular and hotfix releases in one batch are not supported',
    })
  }
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
  const label = displayLabel(entry.id)
  const prTitleLabel = entry.id.kind === 'version' ? `v${entry.id.raw}` : entry.id.name

  try {
    await prepareGitForRelease(entry.type)

    const result = await createSingleRelease({
      id: entry.id,
      jiraConfig,
      description: entry.description,
      type: entry.type,
    })

    logger.info(`✅ Successfully created release: ${prTitleLabel} (${entry.type})`)
    logger.info(`🔗  GitHub PR: ${result.prUrl}`)
    logger.info(`🔗  Jira Version: ${result.jiraVersionUrl}\n`)

    return { result }
  } catch (error) {
    const err = new OperationError(error, {
      operation: `create release ${prTitleLabel} (${entry.type})`,
      remediation: 'verify the version or name is unique and the base branch is clean',
    })

    logger.error(`❌ ${err.message}\n`)

    return { failure: { version: label, error: err.message } }
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
 * (regular/hotfix) and optional Jira description. All entries in a single
 * invocation must share the same type — regular and hotfix releases branch off
 * different bases (dev vs main), so mixed batches are rejected and must be
 * created separately.
 */
export const releaseCreate = async (args: ReleaseCreateArgs) => {
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
    throw new OperationError(undefined, {
      operation: 'create release',
      remediation: 'pass at least one entry in "releases" (e.g. [{ version: "1.2.5", type: "regular" }])',
      stderrExcerpt: 'no releases provided',
    })
  }

  assertHomogeneousReleaseType(entries)

  await assertManagementContext({
    operation: 'create release',
    requiredBranch: getBaseBranch(entries[0]!.type),
  })

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
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const releaseCreateMcpTool = defineMcpTool({
  name: 'release-create',
  description:
    'Create one or more releases in a single call. Each entry in "releases" carries EITHER a "version" (semver or the literal token "next") OR a "name" (free-form kebab-case identifier) — exactly one is required and they are mutually exclusive. Each entry also has its own type (regular|hotfix, default regular) and optional description; all entries in one call must share the same type — mixed regular+hotfix batches are rejected (create them in separate invocations). For each release this tool switches to the appropriate base branch (dev for regular, main for hotfix), cuts the release branch (release/v<semver> for versions, release/<name> for names), opens a GitHub release PR, and creates the matching Jira fix version (v<semver> for versions, <name> for names). The literal token "next" auto-increments from the union of remote release branches and Jira fix versions (regular bumps minor + resets patch; hotfix bumps patch on the highest minor); multiple "next" tokens advance sequentially. Named releases never auto-bump and "next" is version-only. Must be run from the main repository checkout (not a linked worktree) on the matching base branch with a clean working tree. Confirmation is auto-skipped for MCP calls, so the caller is responsible for gating. Continues on per-release failure and reports successes/failures.',
  inputSchema: {
    releases: z
      .array(
        z
          .object({
            version: z
              .string()
              .optional()
              .describe(
                'Version to create (e.g., "1.2.5") or the literal token "next" for auto-increment. Mutually exclusive with "name".',
              ),
            name: z
              .string()
              .optional()
              .describe(
                'Free-form kebab-case release name (e.g., "checkout-redesign"). Mutually exclusive with "version". Named releases never auto-bump.',
              ),
            type: z
              .enum(['regular', 'hotfix'])
              .optional()
              .default('regular')
              .describe('Release type: "regular" (branches off dev) or "hotfix" (branches off main).'),
            description: z.string().optional().describe('Optional description for the Jira version.'),
          })
          .refine(
            (entry) => {
              return (entry.version === undefined) !== (entry.name === undefined)
            },
            {
              message: 'Each release entry must have exactly one of "version" or "name" (they are mutually exclusive).',
            },
          )
          .transform((entry): ReleaseInput => {
            return entry.name !== undefined
              ? { name: entry.name, type: entry.type, ...(entry.description ? { description: entry.description } : {}) }
              : {
                  version: entry.version as string,
                  type: entry.type,
                  ...(entry.description ? { description: entry.description } : {}),
                }
          }),
      )
      .min(1)
      .describe(
        'One or more releases to create. Each entry has exactly one of "version" or "name", plus its own type and optional description.',
      ),
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
})
