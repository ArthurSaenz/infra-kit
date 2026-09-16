import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { ideProviderLabel, openIdeWorkspace } from 'src/integrations/ide'
import {
  OrcaError,
  buildOrcaTerminalTitle,
  createOrcaOpenPoll,
  isOrcaWorktreeListed,
  listOrcaTerminals,
  openOrcaWorktreeTerminals,
  probeOrca,
} from 'src/integrations/orca'
import type { OrcaOpenedLayout, OrcaProbe } from 'src/integrations/orca'
import { commandEcho } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { OperationError } from 'src/lib/errors/operation-error'
import { getMainRepoRoot, getProjectRoot, listWorktrees } from 'src/lib/git-utils'
import type { WorktreeEntry } from 'src/lib/git-utils'
import { getInfraKitConfig, resolveOrcaLayout } from 'src/lib/infra-kit-config'
import type { InfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { discoverInfraKitProjects } from 'src/lib/project-discovery'
import type { DiscoveredProject } from 'src/lib/project-discovery'
import { isReleaseBranch } from 'src/lib/release-id'
import { defineMcpTool, textContent } from 'src/types'
import type { ToolsExecutionResult } from 'src/types'

interface ReopenArgs {
  /** Cross-project fan-out — dispatches to {@link reopenAll} instead of the single-project path. */
  all?: boolean
  /** Narrow `--all` to these project names. Ignored without `--all`. */
  project?: string[]
  /** Discovery roots for `--all` (falls back to the workspace dir when omitted). Ignored without `--all`. */
  root?: string[]
  /** Restrict to release worktrees (reproduces the legacy `worktrees reload` scope). */
  releaseOnly?: boolean
  /** Print the plan and spawn nothing. */
  dryRun?: boolean
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

interface ReopenResult {
  repo: string
  dryRun: boolean
  releaseOnly: boolean
  /** Absolute folder set handed to the editor (root-first, exactly as opened). */
  worktreePaths: string[]
  ideProviders: string[]
  /** Worktrees that got an Orca terminal tab this run (additive: only the ones not already open). */
  orcaOpened: OrcaOpenedEntry[]
  /** Worktrees NOT opened in Orca, with the reason (`already_open` is the idempotent case). */
  orcaSkipped: OrcaSkippedEntry[]
  /** Worktrees whose terminals opened on a row Orca's sidebar hides, with the UI steps. */
  orcaHidden: OrcaHiddenEntry[]
}

/** One worktree to (re)open in Orca: the tab title, the cwd it runs in, and the branch it is reported as. */
interface OrcaTarget {
  branch: string
  title: string
  cwd: string
}

/**
 * Per-repo outcome of an `--all` sweep: either the child's parsed
 * {@link ReopenResult} (with `ok: true`), or an isolated failure record. `repo`
 * is the discovered project name (the child's own `repo` field is overwritten so
 * the aggregate keys off the name the parent discovered).
 */
export type ReopenAllRepoResult =
  (ReopenResult & { repo: string; ok: true }) | { repo: string; ok: false; error: string }

/** Aggregated result of `infra-kit reopen --all` across every discovered project. */
export interface ReopenAllResult {
  all: true
  dryRun: boolean
  projects: DiscoveredProject[]
  results: ReopenAllRepoResult[]
}

/**
 * Entry point for `infra-kit reopen`. Dispatches on `--all`: without it, reopen
 * the current project (see {@link reopenCurrentProject}); with it, discover every
 * infra-kit project and fan out one child process per repo (see
 * {@link reopenAll}). Kept as a thin dispatcher so the single-project path and
 * its MCP tool return the narrow {@link ReopenResult} unchanged.
 */
export const reopen = async (
  options: ReopenArgs = {},
): Promise<ToolsExecutionResult<ReopenResult | ReopenAllResult>> => {
  return options.all ? reopenAll(options) : reopenCurrentProject(options)
}

/**
 * Reopen editor + Orca windows for every *active* worktree in the current project: the main
 * checkout plus every linked worktree (release, feature, detached), regardless of branch.
 * `--release-only` narrows the set to release worktrees.
 *
 * "Active" = a `git worktree list` record that is neither bare nor prunable. Purely additive and
 * idempotent: a worktree with a connected Orca terminal is skipped as `already_open`, so running
 * twice does not double the tabs. There is no close path — Orca's only by-worktree close verb
 * kills every session in the directory, the caller's included. Non-destructive to git — only
 * Orca/editor view state is touched.
 */
export const reopenCurrentProject = async (options: ReopenArgs = {}): Promise<ToolsExecutionResult<ReopenResult>> => {
  const { releaseOnly = false, dryRun = false } = options

  // GUARD (placement is load-bearing): must stay ABOVE the `try` block below. Its catch rethrows only
  // OperationError; getInfraKitConfig's missing-config throw is a PLAIN Error, so a read inside the try
  // is rewrapped and its text is silently dropped by buildMessage — AC3b would fail green.
  const config = await getInfraKitConfig()

  try {
    const projectRoot = await getProjectRoot()
    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`
    // Keyed on the STABLE main-repo root, not the worktree-local one: running `reopen` from
    // inside a linked worktree must address the same Orca repo row as from the main checkout.
    const mainRepoRoot = await getMainRepoRoot(projectRoot)
    const repoName = path.basename(mainRepoRoot)

    const entries = await listWorktrees(projectRoot)
    const active = selectActive(entries, releaseOnly)

    // The exact folder set to open (root-first, harvested from git — the main
    // checkout's own record is already in `entries`, so root is included here).
    const worktreePaths = active.map((entry) => {
      return entry.path
    })

    // Cursor's `.code-workspace` reconcile is release-branch-shaped, so it stays
    // branch-based on the release subset (Zed consumes the paths above).
    const currentBranches = active
      .map((entry) => {
        return entry.branch
      })
      .filter((branch): branch is string => {
        return isReleaseBranch(branch)
      })

    const targets: OrcaTarget[] = active.map((entry) => {
      // Detached / branch-less worktrees have no branch to title from; fall back
      // to the leaf directory so the title is still stable and meaningful.
      const branch = entry.branch ?? path.basename(entry.path)

      return { branch, title: buildOrcaTerminalTitle({ branch }), cwd: entry.path }
    })

    if (dryRun) {
      const result = await planReopen({ repo: repoName, releaseOnly, worktreePaths, targets })

      logDryRun(result, worktreeDir)
      commandEcho.print()

      return { content: textContent(JSON.stringify(result, null, 2)), structuredContent: result }
    }

    const [ideOutcomes, orca] = await Promise.all([
      openIdeWorkspace({ projectRoot, worktreeDir, worktreePaths, currentBranches }),
      reopenOrca({ targets, mainRepoRoot, repoName, config }),
    ])

    const result: ReopenResult = {
      repo: repoName,
      dryRun: false,
      releaseOnly,
      worktreePaths,
      ideProviders: ideOutcomes
        .filter((outcome) => {
          return outcome.ran
        })
        .map((outcome) => {
          return outcome.provider
        }),
      orcaOpened: orca.opened,
      orcaSkipped: orca.skipped,
      orcaHidden: orca.hidden,
    }

    logResults(result, {
      ideRan: ideOutcomes.some((outcome) => {
        return outcome.ran
      }),
    })

    commandEcho.print()

    return { content: textContent(JSON.stringify(result, null, 2)), structuredContent: result }
  } catch (error) {
    if (error instanceof OperationError) throw error

    // `debug`, not `error`: this rethrows as an OperationError, and `entry/cli.ts` logs any
    // uncaught error at ERROR and exits 1 — so logging here too printed one fault as two red
    // lines. Kept (demoted, not deleted) because the wrapped message renders only the operation
    // and remediation; the cause's stack survives here and is reachable with `--debug`.
    logger.debug({ err: error }, 'Error reopening worktree windows')
    throw new OperationError(error, {
      operation: 'reopen worktrees',
      remediation: "run `infra-kit doctor` to check this project's setup",
    })
  }
}

/**
 * Active = neither bare nor prunable. `--release-only` further restricts to
 * release worktrees (reproducing the legacy reload scope). This is a FILTER we
 * must write: `git worktree list` reports bare/prunable records with marker
 * lines, it does not omit them.
 */
const selectActive = (entries: WorktreeEntry[], releaseOnly: boolean): WorktreeEntry[] => {
  return entries.filter((entry) => {
    if (entry.bare || entry.prunable) return false

    return releaseOnly ? isReleaseBranch(entry.branch) : true
  })
}

interface OrcaOutcome {
  opened: OrcaOpenedEntry[]
  skipped: OrcaSkippedEntry[]
  hidden: OrcaHiddenEntry[]
}

const hiddenRowFix = (repoName: string): string => {
  return `Orca → ${repoName} → "hidden worktrees" card → Show, or Settings → General → Workspace → external-worktree sources`
}

const probeSkipReason = (probe: Exclude<OrcaProbe, 'ready'>): OrcaSkipReason => {
  return probe === 'absent' ? 'orca_absent' : 'orca_unreachable'
}

/** "Open" ≡ at least one connected terminal in the worktree — decided by `terminal list`, never by create. */
const isOpenInOrca = async (cwd: string): Promise<boolean> => {
  const { terminals } = await listOrcaTerminals(cwd)

  return terminals.some((terminal) => {
    return terminal.connected
  })
}

/**
 * Partition targets into those that need opening vs. those already open (≥ 1 connected Orca
 * terminal in the cwd). Shared by {@link reopenOrca} and {@link planReopen}, so the dry-run plan
 * and the real run agree on what "already open" means.
 */
const partitionOrcaTargets = async (
  targets: OrcaTarget[],
): Promise<{ toOpen: OrcaTarget[]; skipped: OrcaSkippedEntry[] }> => {
  const toOpen: OrcaTarget[] = []
  const skipped: OrcaSkippedEntry[] = []

  for (const target of targets) {
    if (await isOpenInOrca(target.cwd)) {
      skipped.push({ branch: target.branch, reason: 'already_open' })
    } else {
      toOpen.push(target)
    }
  }

  return { toOpen, skipped }
}

const skipEvery = (targets: OrcaTarget[], reason: OrcaSkipReason): OrcaOutcome => {
  return {
    opened: [],
    skipped: targets.map((target) => {
      return { branch: target.branch, reason }
    }),
    hidden: [],
  }
}

interface ReopenOrcaArgs {
  targets: OrcaTarget[]
  mainRepoRoot: string
  repoName: string
  config: InfraKitConfig
}

type OpenOneOutcome = { opened: OrcaOpenedEntry } | { hidden: OrcaHiddenEntry } | { skipped: OrcaSkippedEntry }

interface OpenOneArgs {
  target: OrcaTarget
  mainRepoRoot: string
  repoName: string
  panes: ReturnType<typeof resolveOrcaLayout>
  poll: ReturnType<typeof createOrcaOpenPoll>
}

/** One target's open + listing check; Orca failures become a skip entry, never a throw. */
const openOneTarget = async (args: OpenOneArgs): Promise<OpenOneOutcome> => {
  const { target, mainRepoRoot, repoName, panes, poll } = args

  try {
    const { layout } = await openOrcaWorktreeTerminals({
      cwd: target.cwd,
      title: target.title,
      focus: false,
      layout: 'full',
      panes,
      poll,
    })

    if (await isOrcaWorktreeListed(mainRepoRoot, target.cwd)) {
      return { opened: { branch: target.branch, layout } }
    }

    return { hidden: { branch: target.branch, path: target.cwd, fix: hiddenRowFix(repoName) } }
  } catch (error) {
    logger.warn({ error, branch: target.branch }, `⚠️ Failed to reopen ${target.branch} in Orca`)

    if (error instanceof OrcaError && error.code === 'orca_worktree_not_selectable') {
      return { skipped: { branch: target.branch, reason: 'orca_worktree_not_selectable' } }
    }

    return {
      skipped: {
        branch: target.branch,
        reason: 'orca_error',
        code: error instanceof OrcaError ? error.code : undefined,
      },
    }
  }
}

/**
 * Open an Orca terminal tab per target that is not already open. Never `--focus`: a fan-out that
 * steals the window on every tab is the mess this avoids, and a background handle lays out just as
 * well (docs/orca-cli-findings.md, axis 2). An Orca that is not ready skips every target with the
 * probe's reason — `reopen` mutates nothing, so it never refuses. Per-target Orca failures are
 * reported, never thrown, so one bad row does not stop the rest.
 */
export const reopenOrca = async (args: ReopenOrcaArgs): Promise<OrcaOutcome> => {
  const { targets, mainRepoRoot, repoName, config } = args

  if (targets.length === 0) return { opened: [], skipped: [], hidden: [] }

  const probe = await probeOrca()

  if (probe !== 'ready') {
    logger.warn(
      `⚠️ ${probe === 'absent' ? 'the orca CLI is not installed' : 'Orca is not running'} — nothing opened in Orca`,
    )

    return skipEvery(targets, probeSkipReason(probe))
  }

  const { toOpen, skipped } = await partitionOrcaTargets(targets)
  const outcome: OrcaOutcome = { opened: [], skipped, hidden: [] }
  const panes = resolveOrcaLayout(config)
  const poll = createOrcaOpenPoll()

  for (const target of toOpen) {
    const one = await openOneTarget({ target, mainRepoRoot, repoName, panes, poll })

    if ('opened' in one) outcome.opened.push(one.opened)
    else if ('hidden' in one) outcome.hidden.push(one.hidden)
    else outcome.skipped.push(one.skipped)
  }

  return outcome
}

interface PlanReopenArgs {
  repo: string
  releaseOnly: boolean
  worktreePaths: string[]
  targets: OrcaTarget[]
}

/**
 * Build the dry-run plan: which folders would open in the editor and which worktrees would open in
 * Orca vs. are already open. Reads Orca's live terminal list but spawns no terminal. A layout is
 * reported as `full` because that is what the real run asks for; `orcaHidden` is unknowable before
 * opening and stays empty.
 */
const planReopen = async (args: PlanReopenArgs): Promise<ReopenResult> => {
  const { repo, releaseOnly, worktreePaths, targets } = args

  const probe = targets.length > 0 ? await probeOrca() : 'ready'
  const orca =
    probe === 'ready'
      ? await partitionOrcaTargets(targets).then(({ toOpen, skipped }) => {
          return {
            opened: toOpen.map((target): OrcaOpenedEntry => {
              return { branch: target.branch, layout: 'full' }
            }),
            skipped,
          }
        })
      : skipEvery(targets, probeSkipReason(probe))

  return {
    repo,
    dryRun: true,
    releaseOnly,
    worktreePaths,
    ideProviders: [],
    orcaOpened: orca.opened,
    orcaSkipped: orca.skipped,
    orcaHidden: [],
  }
}

const logDryRun = (result: ReopenResult, worktreeDir: string): void => {
  logger.info(`🔎 reopen --dry-run for ${result.repo} (worktrees dir: ${worktreeDir})`)
  logger.info(`📂 Would open ${result.worktreePaths.length} folder(s) in the editor:`)
  for (const folder of result.worktreePaths) {
    logger.info(`  ${folder}`)
  }

  if (result.orcaOpened.length > 0) {
    logger.info(`🪟 Would open ${result.orcaOpened.length} worktree(s) in Orca:`)
    for (const entry of result.orcaOpened) {
      logger.info(`  ${entry.branch}`)
    }
  }

  if (result.orcaSkipped.length > 0) {
    logger.info(`↩️ Would skip ${result.orcaSkipped.length} worktree(s) in Orca:`)
    for (const entry of result.orcaSkipped) {
      logger.info(`  ${entry.branch} (${entry.reason})`)
    }
  }
}

interface LogResultsContext {
  ideRan: boolean
}

const logResults = (result: ReopenResult, context: LogResultsContext): void => {
  if (context.ideRan) {
    const ideLabels = result.ideProviders
      .map((provider) => {
        return ideProviderLabel(provider as Parameters<typeof ideProviderLabel>[0])
      })
      .join(', ')

    logger.info(`✅ Opened editor workspace(s): ${ideLabels}`)
  }

  if (result.orcaOpened.length > 0) {
    logger.info('✅ Opened in Orca:')
    for (const entry of result.orcaOpened) {
      logger.info(`  ${entry.branch} (${entry.layout})`)
    }
  }

  for (const entry of result.orcaHidden) {
    logger.info(`🙈 ${entry.branch} opened in Orca but its row is hidden (${entry.path}) — ${entry.fix}`)
  }

  const alreadyOpen = result.orcaSkipped.filter((entry) => {
    return entry.reason === 'already_open'
  })

  if (alreadyOpen.length > 0) {
    logger.info(`↩️ ${alreadyOpen.length} worktree(s) already open in Orca — skipped`)
  }

  for (const entry of result.orcaSkipped) {
    if (entry.reason === 'already_open') continue

    const code = entry.code ? ` (${entry.code})` : ''

    logger.info(`↩️ ${entry.branch} not opened in Orca: ${entry.reason}${code}`)
  }

  if (!context.ideRan && result.orcaOpened.length === 0 && result.orcaHidden.length === 0) {
    logger.info('ℹ️ Nothing to reopen')
  }
}

/**
 * Cross-project fan-out for `--all`. Discovers every live infra-kit project
 * (scanning `--root` or `dirname(getMainRepoRoot())`), then spawns ONE child
 * `reopen --json [flags]` per repo, SERIALLY. Serial is deliberate: concurrent
 * node procs racing the same Orca GUI is the mess serial avoids.
 * Per-child failures are isolated — a repo that errors is recorded and the sweep
 * continues. Renders one aggregated summary and returns one combined result.
 */
const reopenAll = async (options: ReopenArgs): Promise<ToolsExecutionResult<ReopenAllResult>> => {
  const { project = [], root = [], releaseOnly = false, dryRun = false } = options

  const discovered = await discoverInfraKitProjects({ roots: root })
  const projects = filterProjects(discovered, project)
  const childFlags = buildChildFlags({ releaseOnly, dryRun })

  // SERIAL. Not parallel — N node procs racing the Orca GUI is the mess this avoids.
  const results: ReopenAllRepoResult[] = []

  for (const proj of projects) {
    results.push(await runRepoChild(proj, childFlags))
  }

  const result: ReopenAllResult = { all: true, dryRun, projects, results }

  logReopenAll(result)
  commandEcho.print()

  return { content: textContent(JSON.stringify(result, null, 2)), structuredContent: result }
}

/**
 * Narrow the discovered set to `--project` names. Empty → keep all. Names that
 * match nothing are warned and skipped (they never silently widen the sweep).
 */
const filterProjects = (discovered: DiscoveredProject[], names: string[]): DiscoveredProject[] => {
  if (names.length === 0) return discovered

  const discoveredNames = new Set(
    discovered.map((proj) => {
      return proj.name
    }),
  )

  for (const name of names) {
    if (!discoveredNames.has(name)) {
      logger.warn(`⚠️ --project ${name} matched no discovered project — skipping`)
    }
  }

  return discovered.filter((proj) => {
    return names.includes(proj.name)
  })
}

/**
 * The child passthrough flags. `--all` is NEVER passed (it would recurse
 * infinitely); `--project` / `--root` are parent-only and NEVER passed to
 * children. `--json` is added by the spawn itself, not here.
 */
const buildChildFlags = (args: { releaseOnly: boolean; dryRun: boolean }): string[] => {
  const flags: string[] = []

  if (args.dryRun) flags.push('--dry-run')
  if (args.releaseOnly) flags.push('--release-only')

  return flags
}

/**
 * Run one child `reopen --json` in `proj.repoRoot` and parse its single JSON
 * result off stdout. Any failure (non-zero exit, unparseable stdout, spawn
 * error) is isolated into an error record so the caller's sweep continues.
 */
const runRepoChild = async (proj: DiscoveredProject, childFlags: string[]): Promise<ReopenAllRepoResult> => {
  try {
    const stdout = await spawnReopenChild(proj.repoRoot, childFlags)
    const childResult = JSON.parse(stdout) as ReopenResult

    return { ...childResult, repo: proj.name, ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    logger.warn({ error }, `⚠️ reopen failed for ${proj.name} — continuing`)

    return { repo: proj.name, ok: false, error: message }
  }
}

/**
 * Spawn `<node> <this cli.js> reopen --json [flags]` in `cwd` and resolve its
 * stdout. Resolves the CLI via `process.execPath` + `process.argv[1]` — NEVER
 * PATH and NEVER `pnpm exec` (PATH/`pnpm exec` resolution of our own bin is a
 * repeatedly-relearned mistake). Rejects on spawn error or non-zero exit.
 */
const spawnReopenChild = (cwd: string, childFlags: string[]): Promise<string> => {
  const selfCli = process.argv[1]

  if (selfCli === undefined) {
    return Promise.reject(new Error('cannot resolve the infra-kit CLI entry — process.argv[1] is undefined'))
  }

  return new Promise((resolve, reject) => {
    const args = [selfCli, 'reopen', '--json', ...childFlags]

    execFile(process.execPath, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error)

        return
      }

      resolve(stdout)
    })
  })
}

/** Render one aggregated summary for the whole `--all` sweep (parent owns all rendering). */
const logReopenAll = (result: ReopenAllResult): void => {
  const okCount = result.results.filter((repo) => {
    return repo.ok
  }).length
  const failedCount = result.results.length - okCount

  logger.info(`🌐 reopen --all${result.dryRun ? ' --dry-run' : ''}: ${result.projects.length} project(s)`)

  const verb = result.dryRun ? 'planned' : 'opened'
  let totalOpened = 0
  let totalSkipped = 0
  let totalHidden = 0

  for (const repo of result.results) {
    if (repo.ok) {
      totalOpened += repo.orcaOpened.length
      totalSkipped += repo.orcaSkipped.length
      totalHidden += repo.orcaHidden.length

      logger.info(
        `  ✅ ${repo.repo}: ${repo.worktreePaths.length} folder(s), ${repo.orcaOpened.length} Orca ${verb}, ${repo.orcaSkipped.length} skipped, ${repo.orcaHidden.length} hidden`,
      )
    } else {
      logger.info(`  ❌ ${repo.repo}: ${repo.error}`)
    }
  }

  logger.info(
    `📊 ${okCount} ok, ${failedCount} failed — ${totalOpened} Orca ${verb}, ${totalSkipped} skipped, ${totalHidden} hidden`,
  )
}

// MCP Tool Registration
export const reopenMcpTool = defineMcpTool({
  name: 'reopen',
  description:
    "Reopen editor + Orca windows for every active worktree in the current project — the main checkout plus every linked worktree (release, feature, detached). Purely additive and idempotent: a worktree that already has a connected Orca terminal is skipped (orcaSkipped with reason already_open), so running twice does not double the tabs; nothing is ever closed. Zed opens the exact folder set; Cursor reconciles its release-branch-shaped workspace. Set releaseOnly to restrict to release worktrees (the legacy reload scope). Set dryRun to return the plan without spawning anything. When Orca is absent or not running every worktree lands in orcaSkipped with that reason; a worktree whose row Orca's sidebar hides is reported under orcaHidden with the UI steps. Non-destructive to git — only Orca/editor view state is touched.",
  inputSchema: {
    releaseOnly: z
      .boolean()
      .optional()
      .describe('Restrict to release worktrees (reproduces the legacy worktrees-reload scope)'),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        'Return the plan (folders + which worktrees would open in Orca vs. are already open) without spawning anything',
      ),
  },
  outputSchema: {
    repo: z.string().describe('Repository name the reopen ran for'),
    dryRun: z.boolean().describe('Whether this was a dry run (nothing was spawned)'),
    releaseOnly: z.boolean().describe('Whether the set was restricted to release worktrees'),
    worktreePaths: z.array(z.string()).describe('Absolute folder set handed to the editor (root-first)'),
    ideProviders: z.array(z.string()).describe('Configured IDE providers that opened (cursor | zed); empty in dry run'),
    orcaOpened: z
      .array(
        z.object({
          branch: z.string(),
          layout: z.enum(['full', 'single-pane']),
        }),
      )
      .describe('Worktrees that got an Orca terminal tab this run, with the layout applied'),
    orcaSkipped: z
      .array(
        z.object({
          branch: z.string(),
          reason: z.enum(ORCA_SKIP_REASONS),
          code: z.string().optional(),
        }),
      )
      .describe(
        'Worktrees NOT opened in Orca and why: already_open (idempotent skip), orca_absent / orca_unreachable (Orca down), orca_worktree_not_selectable (Orca does not resolve the path), orca_error (code carries the Orca error code)',
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
        'Worktrees whose Orca terminals opened on a row the sidebar HIDES (the repo hides external worktrees); fix names the in-app steps to reveal it',
      ),
  },
  handler: reopenCurrentProject,
})
