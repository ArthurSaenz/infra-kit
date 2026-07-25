import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import {
  buildCmuxWorkspaceTitle,
  closeCmuxWorkspaceByCwd,
  createCmuxGroupFrom,
  findCmuxGroupRefByName,
  listCmuxWorkspacesByCwd,
  openCmuxWorkspaceWithLayout,
  realpathForCmuxCwd,
} from 'src/integrations/cmux'
import { ideProviderLabel, openIdeWorkspace } from 'src/integrations/ide'
import { commandEcho } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { OperationError } from 'src/lib/errors/operation-error'
import { getMainRepoRoot, getProjectRoot, listWorktrees } from 'src/lib/git-utils'
import type { WorktreeEntry } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
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
  /** Close each cmux workspace first, then reopen (the legacy `worktrees reload` behaviour). */
  force?: boolean
  /** Print the plan and spawn nothing. */
  dryRun?: boolean
}

interface ReopenResult {
  repo: string
  dryRun: boolean
  releaseOnly: boolean
  /** Absolute folder set handed to the editor (root-first, exactly as opened). */
  worktreePaths: string[]
  ideProviders: string[]
  /** cmux titles opened this run (additive mode: only the ones not already open). */
  cmuxOpened: string[]
  /** cmux titles skipped because their workspace was already open (additive mode). */
  cmuxSkipped: string[]
  /** cmux titles closed first (only in `--force` mode). */
  cmuxClosed: string[]
}

/** One cmux workspace to (re)open: its canonical-friendly title and the cwd it runs in. */
interface CmuxTarget {
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
 * Reopen editor + cmux windows for every *active* worktree in the current
 * project. "Active" = a `git worktree list` record that is neither bare nor
 * prunable — the main checkout plus every linked worktree (release, feature,
 * detached), regardless of branch. Additive and idempotent by default: cmux
 * workspaces already open are skipped, so running twice does not double the
 * windows. `--force` closes each cmux workspace first (the legacy reload
 * behaviour); `--release-only` narrows the set to release worktrees.
 *
 * Non-destructive to git — only cmux/editor view state is touched.
 */
export const reopenCurrentProject = async (options: ReopenArgs = {}): Promise<ToolsExecutionResult<ReopenResult>> => {
  const { releaseOnly = false, force = false, dryRun = false } = options

  // GUARD (placement is load-bearing): must stay ABOVE the `try` block below. Its catch rethrows only
  // OperationError; getInfraKitConfig's missing-config throw is a PLAIN Error, so a read inside the try
  // is rewrapped and its text is silently dropped by buildMessage — AC3b would fail green.
  await getInfraKitConfig()

  try {
    const projectRoot = await getProjectRoot()
    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`
    // cmux titles are keyed on the STABLE main-repo name (the basename of the main
    // checkout), not the worktree-local basename: running `reopen` from inside a
    // linked worktree must produce the same titles `worktrees add` created from the
    // main checkout, or dedup misses and every run duplicates the windows.
    const repoName = path.basename(await getMainRepoRoot(projectRoot))

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

    const targets: CmuxTarget[] = active.map((entry) => {
      return {
        // Detached / branch-less worktrees have no branch to title from; fall back
        // to the leaf directory so the title is still stable and meaningful.
        title: buildCmuxWorkspaceTitle({ branch: entry.branch ?? path.basename(entry.path) }),
        cwd: entry.path,
      }
    })

    if (dryRun) {
      const result = await planReopen({ repo: repoName, releaseOnly, force, worktreePaths, targets })

      logDryRun(result, worktreeDir)
      commandEcho.print()

      return { content: textContent(JSON.stringify(result, null, 2)), structuredContent: result }
    }

    const [ideOutcomes, cmux] = await Promise.all([
      openIdeWorkspace({ projectRoot, worktreeDir, worktreePaths, currentBranches }),
      runCmux({ targets, force, repoName }),
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
      cmuxOpened: cmux.opened,
      cmuxSkipped: cmux.skipped,
      cmuxClosed: cmux.closed,
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

    logger.error({ error }, '❌ Error reopening worktree windows')
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

interface RunCmuxArgs {
  targets: CmuxTarget[]
  force: boolean
  /** Stable repo name (basename of the main-repo root) → the sidebar group name. */
  repoName: string
}

interface RunCmuxOutcome {
  opened: string[]
  skipped: string[]
  closed: string[]
}

/**
 * Open a cmux workspace for every target, each inside the repo's sidebar group.
 * Default is ADDITIVE + DEDUPED by workspace cwd: a target whose worktree cwd is
 * already open is skipped, which makes `reopen` idempotent (running twice opens
 * nothing new — including the main checkout, whose cwd the group anchor shares but
 * which the cwd map excludes). `--force` closes each target first, then force-opens
 * with no dedup — the escape hatch that recovers the legacy reload behaviour and
 * doubles as the migration for pre-group ungrouped windows.
 */
const runCmux = async (args: RunCmuxArgs): Promise<RunCmuxOutcome> => {
  const { targets, force, repoName } = args

  // Resolve the group ONCE, before the close loop — closing the last member of a
  // group leaves it empty-but-pinned, and a later lookup must not race that.
  const groupRef = await findCmuxGroupRefByName(repoName)

  const closed = force ? await closeCmux({ targets }) : []

  const { opened, skipped } = await reopenCmux({ targets, force, repoName, groupRef })

  return { opened, skipped, closed }
}

interface CloseCmuxArgs {
  targets: CmuxTarget[]
}

/**
 * Close the cmux workspace for each target that is currently open, matched BY CWD
 * (never by title — titles are no longer unique across repos, and a cwd match
 * excludes group anchors so a group header can never be closed). Snapshots the
 * open set up front so the returned list reflects which were actually open; the
 * close itself is best-effort per target.
 */
export const closeCmux = async (args: CloseCmuxArgs): Promise<string[]> => {
  const { targets } = args

  if (targets.length === 0) {
    return []
  }

  const openByCwd = await listCmuxWorkspacesByCwd()

  const closed: string[] = []

  for (const target of targets) {
    if (!openByCwd.has(await realpathForCmuxCwd(target.cwd))) {
      continue
    }

    await closeCmuxWorkspaceByCwd(target.cwd)
    closed.push(target.title)
  }

  return closed
}

interface ReopenCmuxArgs {
  targets: CmuxTarget[]
  force: boolean
  repoName: string
  /** Existing group ref, or null/undefined to bootstrap one from the first opened workspace. */
  groupRef?: string | null
}

interface ReopenCmuxOutcome {
  opened: string[]
  skipped: string[]
}

/**
 * Partition targets into those that need opening vs. those already open, against a
 * set of open workspace cwds (realpath'd, anchors excluded). `force` bypasses dedup
 * entirely — every target lands in `toOpen`. Shared by {@link reopenCmux} and
 * {@link planReopen}.
 */
const partitionCmuxTargets = async (
  targets: CmuxTarget[],
  openCwds: Set<string>,
  force: boolean,
): Promise<{ toOpen: CmuxTarget[]; skipped: string[] }> => {
  const toOpen: CmuxTarget[] = []
  const skipped: string[] = []

  for (const target of targets) {
    if (!force && openCwds.has(await realpathForCmuxCwd(target.cwd))) {
      skipped.push(target.title)
    } else {
      toOpen.push(target)
    }
  }

  return { toOpen, skipped }
}

/**
 * (Re)open a cmux workspace per target, inside the repo's sidebar group. Additive
 * by default — skips any target whose worktree cwd is already open, so a second run
 * opens 0 new workspaces. If no group exists yet, the FIRST opened workspace seeds
 * it via `--from` (capture-free); the rest open straight into it. Under `force`,
 * dedup is bypassed and every target is force-opened (callers close first).
 */
export const reopenCmux = async (args: ReopenCmuxArgs): Promise<ReopenCmuxOutcome> => {
  const { targets, force, repoName, groupRef = null } = args

  // `listCmuxWorkspacesByCwd` returns `∅` when cmux is down or unreadable; its
  // contract says treat empty as "unknown, proceed as if nothing is open", which
  // is exactly force-open behaviour — acceptable here.
  const openCwds = force ? new Set<string>() : new Set((await listCmuxWorkspacesByCwd()).keys())
  const { toOpen, skipped } = await partitionCmuxTargets(targets, openCwds, force)

  const opened: string[] = []
  let group = groupRef
  let bootstrapAttempted = false

  for (const target of toOpen) {
    try {
      if (group) {
        await openCmuxWorkspaceWithLayout({ cwd: target.cwd, title: target.title, group })
      } else {
        const workspaceRef = await openCmuxWorkspaceWithLayout({ cwd: target.cwd, title: target.title })

        // Seed the group from the first workspace we open, once. `--from` makes
        // creation capture-free; if it fails, remaining targets open ungrouped
        // rather than spawning a second group per iteration.
        if (!bootstrapAttempted) {
          group = await createCmuxGroupFrom(repoName, [workspaceRef])
          bootstrapAttempted = true
        }
      }

      opened.push(target.title)
    } catch (error) {
      logger.warn({ error, title: target.title }, `⚠️ Failed to reopen cmux workspace ${target.title}`)
    }
  }

  return { opened, skipped }
}

interface PlanReopenArgs {
  repo: string
  releaseOnly: boolean
  force: boolean
  worktreePaths: string[]
  targets: CmuxTarget[]
}

/**
 * Build the dry-run plan: which folders would open in the editor and which cmux
 * titles would open vs. are already open. Reads the live cmux workspace list but
 * spawns nothing.
 */
const planReopen = async (args: PlanReopenArgs): Promise<ReopenResult> => {
  const { repo, releaseOnly, force, worktreePaths, targets } = args

  const openCwds = force ? new Set<string>() : new Set((await listCmuxWorkspacesByCwd()).keys())
  const { toOpen, skipped } = await partitionCmuxTargets(targets, openCwds, force)

  return {
    repo,
    dryRun: true,
    releaseOnly,
    worktreePaths,
    ideProviders: [],
    cmuxOpened: toOpen.map((target) => {
      return target.title
    }),
    cmuxSkipped: skipped,
    cmuxClosed: [],
  }
}

const logDryRun = (result: ReopenResult, worktreeDir: string): void => {
  logger.info(`🔎 reopen --dry-run for ${result.repo} (worktrees dir: ${worktreeDir})`)
  logger.info(`📂 Would open ${result.worktreePaths.length} folder(s) in the editor:`)
  for (const folder of result.worktreePaths) {
    logger.info(`  ${folder}`)
  }

  if (result.cmuxOpened.length > 0) {
    logger.info(`🪟 Would open ${result.cmuxOpened.length} cmux workspace(s):`)
    for (const title of result.cmuxOpened) {
      logger.info(`  ${title}`)
    }
  }

  if (result.cmuxSkipped.length > 0) {
    logger.info(`↩️ Already open (would skip) ${result.cmuxSkipped.length} cmux workspace(s):`)
    for (const title of result.cmuxSkipped) {
      logger.info(`  ${title}`)
    }
  }
}

interface LogResultsContext {
  ideRan: boolean
}

const logResults = (result: ReopenResult, context: LogResultsContext): void => {
  if (result.cmuxClosed.length > 0) {
    logger.info(`🧹 Closed ${result.cmuxClosed.length} cmux workspace(s)`)
  }

  if (context.ideRan) {
    const ideLabels = result.ideProviders
      .map((provider) => {
        return ideProviderLabel(provider as Parameters<typeof ideProviderLabel>[0])
      })
      .join(', ')

    logger.info(`✅ Opened editor workspace(s): ${ideLabels}`)
  }

  if (result.cmuxOpened.length > 0) {
    logger.info('✅ Opened cmux workspaces:')
    for (const title of result.cmuxOpened) {
      logger.info(title)
    }
  }

  if (result.cmuxSkipped.length > 0) {
    logger.info(`↩️ ${result.cmuxSkipped.length} cmux workspace(s) already open — skipped`)
  }

  if (!context.ideRan && result.cmuxOpened.length === 0 && result.cmuxClosed.length === 0) {
    logger.info('ℹ️ Nothing to reopen')
  }
}

/**
 * Cross-project fan-out for `--all`. Discovers every live infra-kit project
 * (scanning `--root` or `dirname(getMainRepoRoot())`), then spawns ONE child
 * `reopen --json [flags]` per repo, SERIALLY. Serial is deliberate: concurrent
 * node procs racing the same cmux GUI is the focus-stealing mess serial avoids.
 * Per-child failures are isolated — a repo that errors is recorded and the sweep
 * continues. Renders one aggregated summary and returns one combined result.
 */
const reopenAll = async (options: ReopenArgs): Promise<ToolsExecutionResult<ReopenAllResult>> => {
  const { project = [], root = [], releaseOnly = false, force = false, dryRun = false } = options

  const discovered = await discoverInfraKitProjects({ roots: root })
  const projects = filterProjects(discovered, project)
  const childFlags = buildChildFlags({ releaseOnly, force, dryRun })

  // SERIAL. Not parallel — N node procs racing the cmux GUI is the mess this avoids.
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
const buildChildFlags = (args: { releaseOnly: boolean; force: boolean; dryRun: boolean }): string[] => {
  const flags: string[] = []

  if (args.dryRun) flags.push('--dry-run')
  if (args.releaseOnly) flags.push('--release-only')
  if (args.force) flags.push('--force')

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

  let totalOpened = 0
  let totalSkipped = 0

  for (const repo of result.results) {
    if (repo.ok) {
      totalOpened += repo.cmuxOpened.length
      totalSkipped += repo.cmuxSkipped.length

      logger.info(
        `  ✅ ${repo.repo}: ${repo.worktreePaths.length} folder(s), ${repo.cmuxOpened.length} cmux ${result.dryRun ? 'planned' : 'opened'}, ${repo.cmuxSkipped.length} skipped`,
      )
    } else {
      logger.info(`  ❌ ${repo.repo}: ${repo.error}`)
    }
  }

  logger.info(
    `📊 ${okCount} ok, ${failedCount} failed — ${totalOpened} cmux ${result.dryRun ? 'planned' : 'opened'}, ${totalSkipped} already open`,
  )
}

// MCP Tool Registration
export const reopenMcpTool = defineMcpTool({
  name: 'reopen',
  description:
    'Reopen editor + cmux windows for every active worktree in the current project — the main checkout plus every linked worktree (release, feature, detached). Additive and idempotent by default: cmux workspaces already open are skipped, so running twice does not double the windows. Zed opens the exact folder set; Cursor reconciles its release-branch-shaped workspace. Set releaseOnly to restrict to release worktrees (the legacy reload scope). Set force to close each cmux workspace first, then reopen (disruptive). Set dryRun to return the plan without spawning anything. Non-destructive to git — only cmux/editor view state is touched.',
  inputSchema: {
    releaseOnly: z
      .boolean()
      .optional()
      .describe('Restrict to release worktrees (reproduces the legacy worktrees-reload scope)'),
    force: z.boolean().optional().describe('Close each cmux workspace first, then reopen (disruptive)'),
    dryRun: z.boolean().optional().describe('Return the plan (paths + cmux titles) without spawning anything'),
  },
  outputSchema: {
    repo: z.string().describe('Repository name the reopen ran for'),
    dryRun: z.boolean().describe('Whether this was a dry run (nothing was spawned)'),
    releaseOnly: z.boolean().describe('Whether the set was restricted to release worktrees'),
    worktreePaths: z.array(z.string()).describe('Absolute folder set handed to the editor (root-first)'),
    ideProviders: z.array(z.string()).describe('Configured IDE providers that opened (cursor | zed); empty in dry run'),
    cmuxOpened: z.array(z.string()).describe('Titles of cmux workspaces opened this run'),
    cmuxSkipped: z.array(z.string()).describe('Titles of cmux workspaces skipped because already open (additive mode)'),
    cmuxClosed: z.array(z.string()).describe('Titles of cmux workspaces closed first (force mode only)'),
  },
  handler: reopenCurrentProject,
})
