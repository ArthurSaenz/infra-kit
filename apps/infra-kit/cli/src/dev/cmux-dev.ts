/**
 * Resident `infra-kit dev --cmux` supervisor.
 *
 * Opens ONE cmux workspace with one pane per discovered backend API app, each
 * pane running the primitive `pnpm exec infra-kit dev --app=<name>` (single-app,
 * single-process). Stays resident: on SIGINT/SIGTERM it closes the workspace
 * (reaping every pane) and exits. The pure command/layout construction lives here
 * and in {@link file://./cmux-layout.ts} so it is unit-testable without a shell.
 */
import * as path from 'node:path'
import process from 'node:process'

import { closeCmuxDevWorkspace, openCmuxDevWorkspace } from 'src/integrations/cmux'
import { logger } from 'src/lib/logger'

import { buildCmuxLayout } from './cmux-layout.js'
import type { DevServerOptions } from './dev-server.js'
import { discoverApiApps, findMonorepoRoot, normalizeAppInclude } from './discovery.js'
import type { DiscoveredApiApp } from './discovery.js'

/** Build the per-pane primitive command for each app (append `--watch` when requested). */
export const buildPaneCommands = (appNames: string[], watch: boolean): string[] => {
  return appNames.map((name) => {
    return `pnpm exec infra-kit dev --app=${name}${watch ? ' --watch' : ''}`
  })
}

/** Discover API apps under `root`, applying the optional `--app` include filter. */
const selectApiApps = (root: string, include: string[] | null): DiscoveredApiApp[] => {
  const apps = discoverApiApps(root)

  if (!include) {
    return apps
  }

  return apps.filter((app) => {
    return include.includes(app.name)
  })
}

/**
 * Log each app pane and the opened workspace ref. Ports are NOT shown here: each
 * pane binds a dynamic (ephemeral) port at runtime and prints its own real port —
 * the supervisor cannot know it at spawn time, so a static resolved port would lie.
 */
const logDevWorkspace = (apps: DiscoveredApiApp[], ref: string): void => {
  logger.info(`🧩 Opened cmux dev workspace ${ref} with ${apps.length} pane(s):`)

  for (const app of apps) {
    logger.info(`   • ${app.name} (infra-kit dev --app=${app.name})`)
  }
}

/**
 * Register SIGINT/SIGTERM handlers that close the workspace `ref` (once, guarded
 * against a double-fire) and then exit — this is the supervisor's whole teardown.
 */
const registerShutdown = (ref: string): void => {
  let shuttingDown = false

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true

    void (async () => {
      try {
        logger.info(`\nReceived ${signal}, closing cmux dev workspace ${ref}...`)
        await closeCmuxDevWorkspace(ref)
      } finally {
        process.exit(0)
      }
    })()
  }

  process.on('SIGINT', () => {
    return shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    return shutdown('SIGTERM')
  })
}

/**
 * Open a cmux workspace with one pane per API app, then stay resident as a
 * supervisor until a signal tears the workspace down. Falls out early (no
 * workspace) when no apps are discovered. Never returns on the happy path — it
 * owns its own SIGINT/SIGTERM handling and blocks forever otherwise.
 *
 * @example
 * // Runs until Ctrl-C; opens `pnpm exec infra-kit dev --app=<name>` per app.
 * await runCmuxDevServer({ include: null, watch: false })
 */
export const runCmuxDevServer = async (options: DevServerOptions): Promise<void> => {
  const root = findMonorepoRoot(process.cwd())
  const apps = selectApiApps(root, normalizeAppInclude(options.include))

  if (apps.length === 0) {
    logger.warn('No API apps found to run')

    return
  }

  const commands = buildPaneCommands(
    apps.map((app) => {
      return app.name
    }),
    options.watch ?? false,
  )
  const layout = buildCmuxLayout(commands)
  const title = `${path.basename(root)} dev`
  const ref = await openCmuxDevWorkspace({ cwd: root, title, layout })

  logDevWorkspace(apps, ref)
  registerShutdown(ref)

  // Stay resident until a signal fires. A never-resolving promise alone does NOT
  // keep Node's event loop alive (nothing pending → the process exits with code
  // 13, "unsettled top-level await"); a ref'd heartbeat timer holds it open. The
  // SIGINT/SIGTERM handler in registerShutdown owns the actual exit.
  const heartbeat = setInterval(() => {
    heartbeat.refresh()
  }, 2 ** 30)

  await new Promise<never>(() => {})
}
