/* eslint-disable sonarjs/cognitive-complexity */
import confirm from '@inquirer/confirm'
import path from 'node:path'
import { z } from 'zod'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { IDE_MODES, addIdeWorktreeFolders } from 'src/integrations/ide'
import type { IdeMode } from 'src/integrations/ide'
import {
  OrcaError,
  addOrcaRepo,
  buildOrcaTerminalTitle,
  createOrcaOpenPoll,
  findOrcaRepo,
  isOrcaWorktreeListed,
  openOrcaWorktreeTerminals,
  probeOrca,
} from 'src/integrations/orca'
import type { OrcaOpenedLayout, OrcaProbe, OrcaRepoVisibility } from 'src/integrations/orca'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX, WORKTREE_SUBDIRS } from 'src/lib/constants'
import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig, resolveConfiguredIdes, resolveOrcaLayout } from 'src/lib/infra-kit-config'
import type { InfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { pickReleaseBranches } from 'src/lib/prompts/release-picker'
import { formatBranchName, isReleaseBranch, parseReleaseRef } from 'src/lib/release-id'
import { formatBranchPickerItems, getJiraDescriptions, releaseBranchLabels } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

// Constants
const OPERATION = 'create worktrees'

// The two optional follow-ups below declare `whenHeadless: { value: false }`, and that value is not
// a convenience — it is what `githubDesktop`/`orca`'s own `.describe()` text already promises:
// "interactive prompt (CLI) / false (MCP, no TTY)". It was documented and never implemented. With
// neither the flag nor the config key set, a headless call fell through to a real `@inquirer/confirm`,
// which writes to `process.stdout` — under `--json` the one document a machine is parsing — corrupting
// the stream rather than hanging. This command is ungated (`requiresHumanConfirm` is unset), so one
// call carrying `versions` or `all` reached both prompts: the happy path was the defect path.
//
// `{ value: false }` rather than `withEscape`'s `'refuse'` default, and the difference is the whole
// reason the policy is declared per site. Refusing here would be right-outcome-by-accident at best:
// it keeps the bytes out of the stream, but turns a documented harmless default into a hard failure
// and makes the command unusable under `--agent` unless a caller passes both booleans explicitly.
//
// The guard lives in `withEscape` keyed on `isAgentMode()`, never `process.stdin.isTTY`: the agent
// signal is declared (`--agent`/env), and an isTTY key would misfire on the zsh wrappers' `$(…)`
// captures. And never on `confirmedCommand`, which carries the CLI's `--yes` (`program.ts:109`): keying
// on that would stop `worktrees add --yes` prompting on a terminal, breaking the documented order for
// a human in order to fix it for an agent.
//
// ORDER (load-bearing, docs/orca-migration-plan.md §2.4): both follow-ups resolve BEFORE the confirm,
// and — only when Orca resolves true — so do `probeOrca` and `findOrcaRepo`. The confirm preview must
// be able to say "will register <repo> in Orca", and an explicit `--orca` against an Orca that cannot
// honour it must refuse before any git call. When Orca resolves false no `orca` process is spawned.

interface WorktreeManagementArgs extends RequiredConfirmedOptionArg {
  all?: boolean
  versions?: string
  ide?: IdeMode
  /** @deprecated Alias for `ide`, kept for back-compat. Ignored when `ide` is set. */
  cursor?: IdeMode
  githubDesktop?: boolean
  orca?: boolean
}

const ORCA_SKIP_REASONS = [
  'already_open',
  'orca_unreachable',
  'orca_absent',
  'orca_worktree_not_selectable',
  'orca_error',
] as const

type OrcaSkipReason = (typeof ORCA_SKIP_REASONS)[number]

interface OrcaOpenedEntry {
  branch: string
  layout: OrcaOpenedLayout
}

interface OrcaSkippedEntry {
  branch: string
  reason: OrcaSkipReason
  code?: string
}

interface OrcaHiddenEntry {
  branch: string
  path: string
  fix: string
}

interface OrcaOutcomes {
  orcaOpened: OrcaOpenedEntry[]
  orcaSkipped: OrcaSkippedEntry[]
  orcaHidden: OrcaHiddenEntry[]
}

const emptyOrcaOutcomes = (): OrcaOutcomes => {
  return { orcaOpened: [], orcaSkipped: [], orcaHidden: [] }
}

/**
 * What the pre-confirm Orca leg found. `probe !== 'ready'` with a config-derived ask is not a
 * failure: the worktrees are still created and every branch is reported as skipped.
 */
interface OrcaPreflight {
  probe: OrcaProbe
  registered: boolean
  visibility: OrcaRepoVisibility | undefined
}

/**
 * Manage git worktrees for release branches
 * Creates worktrees for active release branches and removes unused ones
 */
export const worktreesAdd = async (options: WorktreeManagementArgs) => {
  const { confirmedCommand, all, versions, githubDesktop, orca } = options
  // `cursor` is the deprecated alias for `ide`; `ide` wins when both are present.
  const ide = options.ide ?? options.cursor

  // Branch-agnostic: `git worktree add` addresses branches by name and never
  // reads HEAD, so only the worktree + clean-tree legs apply.
  await assertManagementContext({ operation: OPERATION })

  try {
    const currentWorktrees = await getCurrentWorktrees('release')
    const projectRoot = await getProjectRoot()

    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

    await ensureWorktreeDirectory(`${worktreeDir}/${WORKTREE_SUBDIRS.release}`)
    await ensureWorktreeDirectory(`${worktreeDir}/${WORKTREE_SUBDIRS.feature}`)

    let selectedReleaseBranches: string[] = []

    if (versions) {
      selectedReleaseBranches = versions.split(',').map((v) => {
        return formatBranchName(parseReleaseRef(v.trim()))
      })
    } else {
      const releasePRsInfo = await getReleasePRsWithInfo()

      const releasePRsList = releasePRsInfo.map((pr) => {
        return pr.branch
      })

      if (releasePRsList.length === 0) {
        logger.info('ℹ️ No open release branches found')

        commandEcho.print()

        const empty = { createdWorktrees: [], count: 0, ...emptyOrcaOutcomes() }

        return {
          content: textContent(JSON.stringify(empty, null, 2)),
          structuredContent: empty,
        }
      }

      if (all) {
        selectedReleaseBranches = releasePRsList
      } else {
        commandEcho.setInteractive()

        const releaseTypes = new Map<string, ReleaseType>(
          releasePRsInfo.map((pr) => {
            return [pr.branch, pr.type]
          }),
        )

        const descriptions = await getJiraDescriptions()

        selectedReleaseBranches = await pickReleaseBranches(
          formatBranchPickerItems({ branches: releasePRsList, descriptions, types: releaseTypes }),
          { required: true },
        )
      }
    }

    // Track --all flag if all branches were selected (either via flag or interactively)
    if (all) {
      commandEcho.addOption('--all', true)
    } else {
      commandEcho.addOption('--versions', releaseBranchLabels(selectedReleaseBranches))
    }

    const config = await getInfraKitConfig()

    // One attach style: every configured editor gets the worktrees added to its
    // workspace. Per-run skip is `--ide none` / `--no-ide`; no editor configured
    // means there's nothing to open.
    const ideMode: IdeMode = ide ?? (resolveConfiguredIdes(config).length > 0 ? 'workspace' : 'none')

    commandEcho.addOption('--ide', ideMode)

    const openInGithubDesktop = await resolveGithubDesktopFollowUp(githubDesktop, config)
    const openInOrca = await resolveOrcaFollowUp(orca, config)

    const mainRepoRoot = await getMainRepoRoot(projectRoot)
    const repoName = path.basename(mainRepoRoot)

    const orcaPreflight = openInOrca ? await preflightOrca({ explicit: orca !== undefined, mainRepoRoot }) : null

    // Ask for confirmation
    await confirmOrExit(confirmedCommand, buildConfirmMessage(orcaPreflight, repoName))

    // Track --yes flag if confirmation was interactive (user confirmed)
    if (!confirmedCommand) {
      commandEcho.addOption('--yes', true)
    }

    // After the confirm (the preview named it) and before `git worktree add` (so the fresh-worktree
    // poll always sees a registered repo).
    const registration = orcaPreflight ? await registerOrcaRepo(orcaPreflight, mainRepoRoot) : null

    const { branchesToCreate } = categorizeWorktrees({
      selectedReleaseBranches,
      currentWorktrees,
    })

    const createdWorktrees = await createWorktrees(branchesToCreate, worktreeDir)

    logResults(createdWorktrees)

    if (ideMode === 'workspace') {
      await addIdeWorktreeFolders({ projectRoot, worktreeDir, branches: createdWorktrees })
    }

    if (openInGithubDesktop) {
      for (const branch of createdWorktrees) {
        await $`github ${worktreeDir}/${branch}`
        await $`sleep 5`
      }
    }

    const orcaOutcomes = registration
      ? await openCreatedWorktreesInOrca({
          registration,
          createdWorktrees,
          worktreeDir,
          mainRepoRoot,
          repoName,
          config,
        })
      : emptyOrcaOutcomes()

    logOrcaOutcomes(orcaOutcomes)

    commandEcho.print()

    const structuredContent = {
      createdWorktrees,
      count: createdWorktrees.length,
      ...orcaOutcomes,
    }

    return {
      content: textContent(JSON.stringify(structuredContent, null, 2)),
      structuredContent,
    }
  } catch (error) {
    // A cancelled prompt (Ctrl-C / Esc) is a user back-out, not a failure: let it
    // reach the top-level boundary untouched so it exits cleanly, instead of being
    // logged as an error with a misleading "branches already exist" remediation.
    if (isPromptCancellation(error)) throw error

    // A refusal with a payload (the confirm site's `confirmation_required`, the explicit-`--orca`
    // refusals) must reach the boundary intact: rewrapped, its `structuredContent` and exit code
    // would be lost under a remediation about branches that already exist. Only this class passes;
    // every other wrap is unchanged.
    if (error instanceof StructuredRefusalError) throw error

    // `debug`, not `error`: this rethrows as an OperationError, and `entry/cli.ts` logs any
    // uncaught error at ERROR and exits 1 — so logging here too printed one fault as two red
    // lines. Kept (demoted, not deleted) because the wrapped message renders only the operation
    // and remediation; the cause's stack survives here and is reachable with `--debug`.
    logger.debug({ err: error }, 'Error managing worktrees')
    throw new OperationError(error, {
      operation: OPERATION,
      remediation: "verify branches don't already exist as worktrees: 'git worktree list'",
    })
  }
}

const resolveGithubDesktopFollowUp = async (flag: boolean | undefined, config: InfraKitConfig): Promise<boolean> => {
  const configured = config.worktrees?.openInGithubDesktop

  const open =
    flag ??
    configured ??
    (await withEscape(
      (context) => {
        return confirm({ message: 'Open created worktrees in GitHub Desktop?' }, context)
      },
      { whenHeadless: { value: false } },
    ))

  if (flag === undefined && configured === undefined) {
    commandEcho.setInteractive()
  }

  commandEcho.addOption(open ? '--github-desktop' : '--no-github-desktop', true)

  return open
}

const resolveOrcaFollowUp = async (flag: boolean | undefined, config: InfraKitConfig): Promise<boolean> => {
  const configured = config.worktrees?.openInOrca

  const open =
    flag ??
    configured ??
    (await withEscape(
      (context) => {
        return confirm({ message: 'Open created worktrees in Orca?', default: true }, context)
      },
      { whenHeadless: { value: false } },
    ))

  if (flag === undefined && configured === undefined) {
    commandEcho.setInteractive()
  }

  commandEcho.addOption(open ? '--orca' : '--no-orca', true)

  return open
}

const describeProbe = (
  probe: Exclude<OrcaProbe, 'ready'>,
): { reason: 'orca_absent' | 'orca_unreachable'; text: string } => {
  return probe === 'absent'
    ? { reason: 'orca_absent', text: 'the orca CLI is not installed (Orca → Settings → Experimental → CLI)' }
    : { reason: 'orca_unreachable', text: 'Orca is not running' }
}

interface PreflightOrcaArgs {
  /** `--orca` was passed, as opposed to resolved from config or the prompt. */
  explicit: boolean
  mainRepoRoot: string
}

/**
 * Refuse only what the operator explicitly asked for; degrade what config merely enabled
 * (docs/orca-migration-plan.md §1, principle 5). A pre-mutation refusal here would otherwise make
 * the GUI's state a precondition for creating git worktrees on every agent run with a layer-2
 * `openInOrca: true`.
 */
const preflightOrca = async (args: PreflightOrcaArgs): Promise<OrcaPreflight> => {
  const { explicit, mainRepoRoot } = args
  const probe = await probeOrca()

  if (probe !== 'ready') {
    const { reason, text } = describeProbe(probe)

    if (explicit) {
      logger.warn({ operation: OPERATION }, `⛔ --orca was passed but ${text}`)

      throw new StructuredRefusalError({ status: 'refused', reason, agentMode: agentMode.source }, 2, {
        operation: OPERATION,
        remediation:
          probe === 'absent'
            ? 'install Orca (brew install --cask stablyai/orca/orca) and register its CLI from Settings → Experimental → CLI, or re-run with --no-orca'
            : 'open Orca (`orca open`) and re-run, or re-run with --no-orca',
        stderrExcerpt: `--orca was passed but ${text}; no worktree was created`,
      })
    }

    logger.warn(`⚠️ ${text} — worktrees will be created but not opened in Orca`)

    return { probe, registered: false, visibility: undefined }
  }

  const repo = await findOrcaRepo(mainRepoRoot)

  return { probe, registered: repo.registered, visibility: repo.visibility }
}

const buildConfirmMessage = (preflight: OrcaPreflight | null, repoName: string): string => {
  const lines = ['Are you sure you want to proceed with these worktree changes?']

  if (preflight?.probe === 'ready' && !preflight.registered) {
    lines.push(
      `  • will register ${repoName} in Orca (orca repo add); its worktrees start hidden in Orca's sidebar until you choose Show`,
    )
  }

  return lines.join('\n')
}

/** The post-confirm state the open loop keys on: a skip reason for the whole batch, or the row visibility. */
type OrcaRegistration =
  | { kind: 'skip'; reason: OrcaSkipReason; code?: string }
  | { kind: 'ready'; visibility: OrcaRepoVisibility | undefined }

const registerOrcaRepo = async (preflight: OrcaPreflight, mainRepoRoot: string): Promise<OrcaRegistration> => {
  if (preflight.probe !== 'ready') {
    return { kind: 'skip', reason: describeProbe(preflight.probe).reason }
  }

  if (preflight.registered) {
    return { kind: 'ready', visibility: preflight.visibility }
  }

  try {
    const { visibility } = await addOrcaRepo(mainRepoRoot)

    return { kind: 'ready', visibility }
  } catch (error) {
    // A GUI registration failure never blocks git (the same rule as an unreachable Orca).
    logger.warn({ error }, '⚠️ orca repo add failed — worktrees will be created but not opened in Orca')

    return { kind: 'skip', reason: 'orca_error', code: error instanceof OrcaError ? error.code : undefined }
  }
}

interface OpenCreatedWorktreesInOrcaArgs {
  registration: OrcaRegistration
  createdWorktrees: string[]
  worktreeDir: string
  mainRepoRoot: string
  repoName: string
  config: InfraKitConfig
}

const hiddenRowFix = (repoName: string): string => {
  return `Orca → ${repoName} → "hidden worktrees" card → Show, or Settings → General → Workspace → external-worktree sources`
}

/**
 * Lay out every created worktree — no already-open check, because `createWorktrees` only returns
 * worktrees that did not exist a moment ago (a terminal Orca's own hooks might auto-start there is
 * additive). `--focus` only for a single target on a row the sidebar shows: on a hidden row it times
 * out (docs/orca-cli-findings.md, axis 1), so hidden repos open in the background and are reported
 * under `orcaHidden` with the UI steps.
 */
const openCreatedWorktreesInOrca = async (args: OpenCreatedWorktreesInOrcaArgs): Promise<OrcaOutcomes> => {
  const { registration, createdWorktrees, worktreeDir, mainRepoRoot, repoName, config } = args
  const outcomes = emptyOrcaOutcomes()

  if (registration.kind === 'skip') {
    for (const branch of createdWorktrees) {
      outcomes.orcaSkipped.push({ branch, reason: registration.reason, code: registration.code })
    }

    return outcomes
  }

  const panes = resolveOrcaLayout(config)
  const focus = createdWorktrees.length === 1 && registration.visibility !== 'hide'
  const poll = createOrcaOpenPoll()

  for (const branch of createdWorktrees) {
    const cwd = `${worktreeDir}/${branch}`

    try {
      const { layout } = await openOrcaWorktreeTerminals({
        cwd,
        title: buildOrcaTerminalTitle({ branch }),
        focus,
        layout: 'full',
        panes,
        poll,
      })

      if (await isOrcaWorktreeListed(mainRepoRoot, cwd)) {
        outcomes.orcaOpened.push({ branch, layout })
      } else {
        outcomes.orcaHidden.push({ branch, path: cwd, fix: hiddenRowFix(repoName) })
      }
    } catch (error) {
      logger.warn({ error, branch }, `⚠️ Failed to open Orca terminals for ${branch}`)

      if (error instanceof OrcaError && error.code === 'orca_worktree_not_selectable') {
        outcomes.orcaSkipped.push({ branch, reason: 'orca_worktree_not_selectable' })
      } else {
        outcomes.orcaSkipped.push({
          branch,
          reason: 'orca_error',
          code: error instanceof OrcaError ? error.code : undefined,
        })
      }
    }
  }

  return outcomes
}

const logOrcaOutcomes = (outcomes: OrcaOutcomes): void => {
  for (const entry of outcomes.orcaOpened) {
    logger.info(`🪟 Opened ${entry.branch} in Orca (${entry.layout})`)
  }

  for (const entry of outcomes.orcaHidden) {
    logger.info(`🙈 ${entry.branch} opened in Orca but its row is hidden (${entry.path}) — ${entry.fix}`)
  }

  for (const entry of outcomes.orcaSkipped) {
    const code = entry.code ? ` (${entry.code})` : ''

    logger.info(`↩️ ${entry.branch} not opened in Orca: ${entry.reason}${code}`)
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
    return isReleaseBranch(branch)
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
      const err = new OperationError(result.reason, {
        operation: `git worktree add for ${branch}`,
        remediation: 'check the branch name and that the parent dir is writable',
      })

      logger.error({ error: result.reason, msg: err.message })
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
export const worktreesAddMcpTool = defineMcpTool({
  name: 'worktrees-add',
  description:
    'Create local git worktrees for release branches under the worktrees directory and run "pnpm install" in each. Mutates the local filesystem. When invoked via MCP, pass either "versions" (comma-separated) or all=true — the branch picker and "open in Cursor / GitHub Desktop / Orca" follow-up prompts are unreachable without a TTY, and the CLI confirmation is auto-skipped for MCP calls. With "orca" true each created worktree gets an Orca terminal tab laid out per "worktrees.orca.layout"; the result reports orcaOpened, orcaSkipped (with a reason) and orcaHidden (a worktree Orca\'s sidebar hides, with the UI steps to reveal it). An unregistered repo is registered in Orca first (orca repo add).',
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
        'Comma-separated release versions or names to target (e.g. "1.2.5, 1.2.6" or "checkout-redesign, 1.2.5"). Either "versions" or all=true must be provided for MCP calls. Overrides "all" when set.',
      ),
    ide: z
      .enum(IDE_MODES)
      .optional()
      .describe(
        'Editor open mode for created worktrees, applied to the configured editor (Cursor, per the "ide" config). "workspace" (the only attach style) adds each worktree to the Cursor workspace and opens it. "none" skips the editor. Resolution order: this flag → "workspace" when an "ide" is configured → "none" otherwise.',
      ),
    cursor: z
      .enum(IDE_MODES)
      .optional()
      .describe('Deprecated alias for "ide". Prefer "ide". Ignored when "ide" is provided.'),
    githubDesktop: z
      .boolean()
      .optional()
      .describe(
        'Open each created worktree in GitHub Desktop. Resolution order: this flag → "worktrees.openInGithubDesktop" from infra-kit config → interactive prompt (CLI) / false (MCP, no TTY).',
      ),
    orca: z
      .boolean()
      .optional()
      .describe(
        'Open each created worktree in Orca: one terminal tab per worktree, laid out per "worktrees.orca.layout" (default "two-columns": left | right; or "three-pane": left split top/bottom + full-height right). Resolution order: this flag → "worktrees.openInOrca" from infra-kit config → interactive prompt (CLI, default yes) / false (MCP, no TTY). Passed explicitly, an Orca that is absent or not running is refused before any worktree is created (orca_absent / orca_unreachable); resolved from config it degrades to orcaSkipped with that reason.',
      ),
  },
  outputSchema: {
    createdWorktrees: z.array(z.string()).describe('List of created git worktree branches'),
    count: z.number().describe('Number of git worktrees created'),
    orcaOpened: z
      .array(
        z.object({
          branch: z.string(),
          layout: z.enum(['full', 'single-pane']),
        }),
      )
      .describe('Created worktrees that got an Orca terminal tab on a row the sidebar shows, with the layout applied'),
    orcaSkipped: z
      .array(
        z.object({
          branch: z.string(),
          reason: z.enum(ORCA_SKIP_REASONS),
          code: z.string().optional(),
        }),
      )
      .describe(
        'Created worktrees NOT opened in Orca and why: orca_absent / orca_unreachable (config-derived ask, Orca down), orca_worktree_not_selectable (Orca had not scanned the fresh worktree yet), orca_error (code carries the Orca error code)',
      ),
    orcaHidden: z
      .array(
        z.object({
          branch: z.string(),
          path: z.string(),
          fix: z.string(),
        }),
      )
      .describe(
        'Created worktrees whose Orca terminals opened on a row the sidebar HIDES (the repo hides external worktrees); fix names the in-app steps to reveal it',
      ),
  },
  handler: worktreesAdd,
})
