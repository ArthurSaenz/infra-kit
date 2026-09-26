/**
 * Resident `infra-kit dev --orca` supervisor.
 *
 * Opens ONE Orca tab with one pane per discovered backend API app, each pane
 * running the primitive `pnpm exec infra-kit dev --app=<name>` (single-app,
 * single-process). Stays resident: on SIGINT/SIGTERM it closes the tab (reaping
 * every pane) and exits. The pure command/split construction lives here and in
 * {@link file://./orca-split-plan.ts} so it is unit-testable without a shell.
 */
import * as path from 'node:path'
import process from 'node:process'

import { findOrcaRepo, isOrcaWorktreeListed, probeOrca, runOrca } from 'src/integrations/orca'
import type { OrcaTerminalCreateResult, OrcaTerminalSplitResult } from 'src/integrations/orca'
import { getMainRepoRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'

import type { DevServerOptions } from './dev-server.js'
import { discoverApiApps, findMonorepoRoot, normalizeAppInclude } from './discovery.js'
import type { DiscoveredApiApp } from './discovery.js'
import { buildOrcaSplitPlan } from './orca-split-plan.js'
import type { OrcaSplitStep } from './orca-split-plan.js'
import { registerSignalShutdown } from './signal-shutdown.js'

/** One Orca pane: the app it runs, and (optionally) the exact `<app>/<part>` targets selected for it. */
export interface PaneSpec {
  app: string
  /**
   * Exact target keys for this pane. When absent the pane falls back to `--app=<name>`, which expands to
   * EVERY part the app has (both the api and the ui glob targets) — right for a plain `--orca`, wrong for a wizard selection
   * that deliberately unticked a part. `--app` has app-name granularity and cannot express `<app>/api`
   * alone; that is exactly what `--target` exists for.
   */
  targets?: string[]
}

/** The supervisor either stays resident (`ran`, never actually returned) or explains why the caller should run in-process. */
export type OrcaDevOutcome = 'ran' | { fallback: string }

/** Build the per-pane primitive command for each pane (append `--no-watch` when watch is off). */
export const buildPaneCommands = (panes: PaneSpec[], watch: boolean): string[] => {
  return panes.map(({ app, targets }) => {
    const selector = targets && targets.length > 0 ? `--target=${targets.join(',')}` : `--app=${app}`

    return `pnpm exec infra-kit dev ${selector}${watch ? '' : ' --no-watch'}`
  })
}

/** The concrete `<app>/<part>` keys of an in-memory preset, grouped by app. Glob keys (those whose app segment is a bare star) are skipped. */
export const paneTargetsByApp = (presetDef: DevServerOptions['presetDef']): Map<string, string[]> => {
  const byApp = new Map<string, string[]>()

  for (const key of Object.keys(presetDef?.apps ?? {})) {
    const app = key.split('/')[0]

    if (app === undefined || app === '*') continue

    byApp.set(app, [...(byApp.get(app) ?? []), key])
  }

  return byApp
}

/** Discover API apps under `root`, applying the optional `--app` include filter. */
export const selectApiApps = (root: string, include: string[] | null): DiscoveredApiApp[] => {
  const apps = discoverApiApps(root)

  if (!include) {
    return apps
  }

  return apps.filter((app) => {
    return include.includes(app.name)
  })
}

/**
 * The reasons `--orca` cannot be honoured, checked in the order a user can fix
 * them. `dev` has no confirm step, so it never registers the repo itself (that
 * mutation belongs to `worktrees add`).
 *
 * A hidden row is a fallback rather than a silent open: `terminal create` still
 * succeeds there, but `--focus` — the only verb that could reveal it — times out
 * on a hidden row (docs/orca-cli-findings.md, axis 1), so the servers would start
 * in a tab nobody can see.
 */
const findOrcaFallback = async (mainRepoRoot: string, root: string): Promise<string | null> => {
  const probe = await probeOrca()

  if (probe === 'absent') return 'Orca is not installed'
  if (probe === 'unreachable') return 'Orca is not running'

  const repo = path.basename(mainRepoRoot)

  if (!(await findOrcaRepo(mainRepoRoot)).registered) {
    return `${repo} is not registered in Orca — run \`infra-kit worktrees add\` once, it offers to register it`
  }

  if (!(await isOrcaWorktreeListed(mainRepoRoot, root))) {
    return `this worktree is hidden in Orca's sidebar — open Orca → ${repo} → "hidden worktrees" → Show`
  }

  return null
}

const splitPane = async (handles: string[], step: OrcaSplitStep): Promise<string> => {
  const result = await runOrca<OrcaTerminalSplitResult>([
    'terminal',
    'split',
    '--terminal',
    handles[step.from]!,
    '--direction',
    step.direction,
    '--command',
    step.command,
  ])

  return result.split.handle
}

/**
 * Close the tab through its first pane; a second `dev --orca` would otherwise
 * stack a same-titled tab next to the stale one (docs/orca-cli-findings.md §3.11).
 * When that refuses, every recorded handle is closed on its own, tolerating
 * panes the user already closed. Never `--worktree … --all`: it would also take
 * the shells the user opened in this worktree, and it refuses while any is live.
 */
const closeDevTab = async (handles: string[]): Promise<void> => {
  try {
    await runOrca(['terminal', 'close', '--terminal', handles[0]!, '--tab'])

    return
  } catch (error) {
    logger.debug({ error }, 'orca: tab close refused, closing panes one by one')
  }

  for (const handle of handles) {
    try {
      await runOrca(['terminal', 'close', '--terminal', handle])
    } catch (error) {
      logger.debug({ handle, error }, 'orca: pane already gone')
    }
  }
}

/**
 * Open the tab: `create` for the first command, then the split plan in order. No
 * `--focus`: a background handle is splittable in the same tab (axis 2), and
 * stealing the window on every `dev` start is a regression. A split that fails
 * midway tears the half-built tab down first, so a dev server never keeps
 * running in a tab the supervisor has forgotten.
 */
const openDevTab = async (root: string, title: string, commands: string[]): Promise<string[]> => {
  const created = await runOrca<OrcaTerminalCreateResult>([
    'terminal',
    'create',
    '--worktree',
    `path:${root}`,
    '--title',
    title,
    '--command',
    commands[0]!,
  ])
  const handles = [created.terminal.handle]

  try {
    for (const step of buildOrcaSplitPlan(commands)) {
      handles.push(await splitPane(handles, step))
    }
  } catch (error) {
    await closeDevTab(handles)

    throw error
  }

  return handles
}

/**
 * Log each pane and the opened tab. Ports are NOT shown here: each pane binds a
 * dynamic (ephemeral) port at runtime and prints its own real port — the
 * supervisor cannot know it at spawn time, so a static resolved port would lie.
 */
const logDevTab = (apps: DiscoveredApiApp[], commands: string[], title: string): void => {
  logger.info(`🧩 Opened Orca tab "${title}" with ${apps.length} pane(s):`)

  apps.forEach((app, index) => {
    logger.info(`   • ${app.name} (${commands[index]})`)
  })
}

/**
 * Register SIGINT/SIGTERM handlers that close the tab — the supervisor's whole teardown. No
 * force-deadline: closing a tab is a couple of CLI calls, not a child reap, and a second signal is
 * already an unconditional escape (see {@link registerSignalShutdown}).
 */
const registerShutdown = (handles: string[], title: string): void => {
  registerSignalShutdown({
    onSignal: async (signal) => {
      logger.info(`\nReceived ${signal}, closing Orca tab "${title}"...`)
      await closeDevTab(handles)
    },
  })
}

/**
 * Open an Orca tab with one pane per API app, then stay resident as a supervisor
 * until a signal tears the tab down. Returns a `fallback` reason — and opens
 * nothing — when Orca cannot show the panes; the caller runs in-process instead.
 * Never returns on the happy path: it owns its own SIGINT/SIGTERM handling and
 * blocks forever otherwise.
 *
 * @example
 * // Runs until Ctrl-C; opens `pnpm exec infra-kit dev --app=<name>` per app.
 * const outcome = await runOrcaDevServer({ include: null, watch: false })
 * if (outcome !== 'ran') console.log(outcome.fallback)
 */
export const runOrcaDevServer = async (options: DevServerOptions): Promise<OrcaDevOutcome> => {
  const root = findMonorepoRoot(process.cwd())
  const apps = selectApiApps(root, normalizeAppInclude(options.include))

  if (apps.length === 0) {
    return { fallback: 'no API apps to open a pane for (panes are backend-only)' }
  }

  const fallback = await findOrcaFallback(await getMainRepoRoot(root), root)

  if (fallback !== null) {
    return { fallback }
  }

  // A wizard run hands down its in-memory preset, so each pane reproduces the exact parts that were
  // ticked. A plain `--orca` has no presetDef and falls back to `--app=<name>` (every part), unchanged.
  const targetsByApp = paneTargetsByApp(options.presetDef)
  const commands = buildPaneCommands(
    apps.map((app) => {
      return { app: app.name, targets: targetsByApp.get(app.name) }
    }),
    options.watch ?? false,
  )
  const title = `${path.basename(root)} dev`
  const handles = await openDevTab(root, title, commands)

  logDevTab(apps, commands, title)
  registerShutdown(handles, title)

  // Stay resident until a signal fires. A never-resolving promise alone does NOT
  // keep Node's event loop alive (nothing pending → the process exits with code
  // 13, "unsettled top-level await"); a ref'd heartbeat timer holds it open. The
  // SIGINT/SIGTERM handler in registerShutdown owns the actual exit.
  const heartbeat = setInterval(() => {
    heartbeat.refresh()
  }, 2 ** 30)

  await new Promise<never>(() => {})

  return 'ran'
}
