/**
 * Unified Development Server Runner
 *
 * Discovers and runs API apps under each `apps/<app>/api` folder that contains `serverless.yml`.
 *
 * Ports: `{APP}_PORT`, then `process.env.PORT`, then `dev.<app>.port` from infra-kit.json,
 * else 3010. URL prefix: `dev.<app>.prefixUrl`, else `/api/v1`.
 * Env vars should be provided via secrets manager (e.g. `doppler run -- pnpm dev-server`) or shell.
 *
 * This module is side-effect free on import: call `run()` (or construct `DevServerRunner`
 * directly) to start. Signal handling and process exit are the entry point's responsibility.
 *
 * Runner messages append to `<cwd>/.infra-kit/dev-server.log`. Lambda / Powertools logs from
 * handlers go to stdout.
 */
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { exec } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import util from 'node:util'

import type { DevConfig } from 'src/lib/infra-kit-config'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'

import {
  classifyDistChange,
  discoverApiApps as discoverApiAppsBare,
  discoverUiApps as discoverUiAppsBare,
  findMonorepoRoot,
  getAppDistDirs,
  getPackageDistDirs,
  normalizeAppInclude as normalizeAppIncludePure,
} from './discovery.js'
import type { DiscoveredUiApp } from './discovery.js'
import { findPortConflicts, resolvePort as resolvePortPure, resolvePrefixUrl as resolvePrefixUrlPure } from './ports.js'
import { ServerlessLocalRun } from './serverless-local-run.js'
import { defaultTurboWatchFactory } from './turbo-watch.js'
import type { TurboWatchFactory, TurboWatchHandle } from './turbo-watch.js'
import { defaultUiDevFactory } from './ui-dev.js'
import type { UiDevFactory, UiDevHandle } from './ui-dev.js'

/** Runner-only log file, resolved under the consumer repo's `.infra-kit/` dir at startup. */
let LOG_FILE_PATH = path.join(process.cwd(), '.infra-kit', 'dev-server.log')

/** Resolve `<cwd>/.infra-kit/dev-server.log`, ensure the dir exists, and clear the file. */
function initLogFile(): void {
  LOG_FILE_PATH = path.join(process.cwd(), '.infra-kit', 'dev-server.log')
  fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true })
  fs.writeFileSync(LOG_FILE_PATH, `=== Dev Server Started: ${new Date().toISOString()} ===\n\n`)
}

const execFn = util.promisify(exec)

type LogFn = (msg: string, level?: 'info' | 'warn' | 'error' | 'debug') => void

/**
 * Build seam: shells out to turbo by default ({@link launchScript}); injectable so
 * tests can run the orchestrator without a real build. `logFn` is optional so both
 * the verbose initial build and the terse restart builds keep their current output.
 */
export type BuildRunner = (cmd: string, logFn?: LogFn) => Promise<void>

const launchScript = async (script: string, logFn?: LogFn): Promise<void> => {
  try {
    const { stderr } = await execFn(script)

    if (stderr && logFn) logFn(`   (build) ${stderr.trim()}`, 'debug')
    if (stderr && !logFn) console.error('stderr:', stderr)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }

    if (logFn && (err.stdout || err.stderr)) {
      if (err.stdout) logFn(`   stdout: ${err.stdout.trim()}`, 'error')
      if (err.stderr) logFn(`   stderr: ${err.stderr.trim()}`, 'error')
    }

    throw error
  }
}

/** Append raw text to the runner-only log file (the single tee-to-file seam). */
function appendLogFile(text: string): void {
  fs.appendFileSync(LOG_FILE_PATH, text)
}

/** Write a message to the console (routed by level) and tee it to the log file. */
function log(message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info'): void {
  if (level === 'error') {
    console.error(message)
  } else if (level === 'warn') {
    console.warn(message)
  } else {
    process.stdout.write(`${message}\n`)
  }

  appendLogFile(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`)
}

/** Write pre-formatted table lines to stdout and tee them to the log file. */
function logTable(lines: string[]): void {
  const output = `${lines.join('\n')}\n`

  process.stdout.write(`${output}\n`)
  appendLogFile(`${output}\n`)
}

/** Center `s` within `width` columns (clamped, so a too-long string is never truncated). */
function center(s: string, width: number): string {
  const pad = Math.max(0, width - s.length)
  const left = Math.floor(pad / 2)

  return `${' '.repeat(left)}${s}${' '.repeat(pad - left)}`
}

/**
 * Render a box-drawn table whose column widths are computed from the longest cell in
 * each column, so every emitted line shares one width regardless of app-name length
 * (the old fixed `padEnd` misaligned on long names). Borders are generated from the
 * same widths, so they always match the rows.
 */
function renderTable(title: string, headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, i) => {
    return Math.max(
      header.length,
      ...rows.map((row) => {
        return (row[i] ?? '').length
      }),
    )
  })
  // Grow the last column if the title is wider than the columns, so the title band never clips.
  const columnsInner =
    widths.reduce((sum, w) => {
      return sum + w + 2
    }, 0) +
    (widths.length - 1)

  const lastIdx = widths.length - 1

  if (lastIdx >= 0 && title.length + 2 > columnsInner) {
    widths[lastIdx] = (widths[lastIdx] ?? 0) + (title.length + 2 - columnsInner)
  }

  const inner =
    widths.reduce((sum, w) => {
      return sum + w + 2
    }, 0) +
    (widths.length - 1)
  const blocks = widths.map((w) => {
    return '─'.repeat(w + 2)
  })
  const rowLine = (cells: string[]): string => {
    return `│ ${cells
      .map((c, i) => {
        return (c ?? '').padEnd(widths[i]!)
      })
      .join(' │ ')} │`
  }

  return [
    '',
    `┌${'─'.repeat(inner)}┐`,
    `│${center(title, inner)}│`,
    `├${blocks.join('┬')}┤`,
    rowLine(headers),
    `├${blocks.join('┼')}┤`,
    ...rows.map(rowLine),
    `└${blocks.join('┴')}┘`,
    '',
  ]
}

interface IApiAppConfig {
  /** App folder name (e.g. backoffice, client) */
  name: string
  /** Package name from package.json (e.g. sls-trvl-client) */
  packageName: string
  path: string
  port: number
  prefixUrl: string
}

/**
 * Runner options, parsed by the CLI entry point (`--watch`, `--app`) and threaded
 * through `run()`. The entry owns flag parsing; the runner never reads `process.argv`
 * itself. App selection is `--app` only; ports come from env/config (see `resolvePort`).
 */
export interface DevServerOptions {
  /**
   * Watch mode: start a long-lived `turbo watch build` engine (incremental rebuilds
   * + dependency fan-out) and restart the affected server(s) when compiled `dist/`
   * changes. Without it, `dev` builds and serves once and exits on signal.
   */
  watch?: boolean
  /** Only run these app folder names (null/empty = all discovered). Filters BOTH api and ui apps. */
  include?: string[] | null
  /**
   * Also run frontends: discover `apps/<app>/ui` with a `dev` script and start them via one
   * delegated `turbo run dev` child (streamed to the terminal). Default (unset) = api-only,
   * preserving today's behavior.
   */
  ui?: boolean
  /**
   * Run each discovered API app in its own cmux pane (one workspace, N panes), supervised by a
   * resident process that closes the workspace on signal. Falls back to single-process dev when
   * cmux is absent. Handled by `runCmuxDevServer`, not the in-process `DevServerRunner`.
   */
  cmux?: boolean
  /**
   * Infer the single app to run from the current working directory (equivalent to
   * `--app=<that app>`), so every app can share the identical script
   * `pnpm exec infra-kit dev --self` instead of hardcoding its own folder name.
   * Resolved by the entry point (`resolveSelfAppName`) into `include` before this
   * runner ever sees it; the runner itself does not read `self`.
   */
  self?: boolean
}

interface IAppServer {
  app: IApiAppConfig
  server: ServerlessLocalRun
}

export class DevServerRunner {
  private readonly monorepoRoot: string
  private readonly appServers: IAppServer[] = []
  private watchDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  /** Active chokidar watcher in `--watch` mode; closed on {@link shutdown}. */
  private watcher: FSWatcher | null = null
  private static readonly WATCH_DEBOUNCE_MS = 400
  /** Serialized restarts so rapid saves never bind :port while the previous server is still shutting down. */
  private restartWorkChain: Promise<void> = Promise.resolve()
  private static readonly PORT_RELEASE_DELAY_MS = 200
  private readonly options: DevServerOptions
  /** Build runner seam — real turbo shell-out by default, injectable for tests. */
  private readonly runBuild: BuildRunner
  /** `turbo watch` spawn seam — real detached child by default, injectable for tests. */
  private readonly turboWatchFactory: TurboWatchFactory
  /** Live `turbo watch` engine in `--watch` mode; reaped on {@link shutdown}. */
  private turboWatch: TurboWatchHandle | null = null
  /** `turbo run dev` (frontends) spawn seam — real detached child by default, injectable for tests. */
  private readonly uiDevFactory: UiDevFactory
  /** Live `turbo run dev` frontend engine in `--ui` mode; reaped on {@link shutdown}. */
  private uiDev: UiDevHandle | null = null

  constructor(
    options: DevServerOptions = {},
    runBuild: BuildRunner = launchScript,
    turboWatchFactory: TurboWatchFactory = defaultTurboWatchFactory,
    uiDevFactory: UiDevFactory = defaultUiDevFactory,
  ) {
    this.options = options
    this.runBuild = runBuild
    this.turboWatchFactory = turboWatchFactory
    this.uiDevFactory = uiDevFactory
    initLogFile()

    // Walk up from the consumer repo cwd to the monorepo root.
    this.monorepoRoot = findMonorepoRoot(process.cwd())
    log(`Monorepo root: ${this.monorepoRoot}`)

    if (process.env.DOPPLER_PROJECT != null || process.env.DOPPLER_ENVIRONMENT != null) {
      log('🔐 Doppler env detected (DOPPLER_PROJECT / DOPPLER_ENVIRONMENT)', 'debug')
    }
  }

  /**
   * Discover API apps and resolve each app's port + URL prefix. Delegates bare
   * filesystem discovery to {@link discoverApiAppsBare} and per-app resolution to
   * the pure `resolvePort` / `resolvePrefixUrl`, preserving the original behavior.
   */
  private discoverApiApps(devConfig: DevConfig): IApiAppConfig[] {
    return discoverApiAppsBare(this.monorepoRoot).map((app) => {
      return {
        ...app,
        port: this.resolvePort(app.name, devConfig),
        prefixUrl: this.resolvePrefixUrl(app.name, devConfig),
      }
    })
  }

  /**
   * Read the `dev` section from the resolved infra-kit config. Defensive: any
   * failure (not in an infra-kit project, missing/invalid config) resolves to an
   * empty map so the dev-server always falls back to env vars + built-in defaults
   * rather than refusing to start.
   */
  private async loadDevConfig(): Promise<DevConfig> {
    try {
      const config = await getInfraKitConfig()

      return config.dev ?? {}
    } catch {
      return {}
    }
  }

  /** Thin delegator to the pure {@link normalizeAppIncludePure} over the runner's `--app` list. */
  private normalizeAppInclude(): string[] | null {
    return normalizeAppIncludePure(this.options.include)
  }

  /** Thin delegator to the pure {@link resolvePortPure}, threading env + config. */
  private resolvePort(appName: string, devConfig: DevConfig): number {
    return resolvePortPure(appName, process.env, devConfig)
  }

  /** Thin delegator to the pure {@link resolvePrefixUrlPure}. */
  private resolvePrefixUrl(appName: string, devConfig: DevConfig): string {
    return resolvePrefixUrlPure(appName, devConfig)
  }

  public async start(): Promise<void> {
    const include = this.normalizeAppInclude()
    const watch = this.options.watch ?? false
    const devConfig = await this.loadDevConfig()

    process.env.POWERTOOLS_DEV ??= 'true'
    process.env.LOG_LEVEL ??= 'DEBUG'

    log('🚀 Starting Development Server Runner')

    if (watch) {
      log('👀 Watch mode: will rebuild and restart on file save')
    }
    log(`📂 Monorepo root: ${this.monorepoRoot}`)

    // Run everything an app exposes: API emulators + frontends (any `apps/<app>/ui` with a `dev`
    // script). `--app` narrows BOTH. There is no api-only/ui-only toggle — `--app` is the one selector.
    const apps = this.selectApps(this.discoverApiApps(devConfig), include)
    const uiApps = this.selectUiApps(include)

    if (apps.length === 0 && uiApps.length === 0) {
      log('⚠️  No API or UI apps found to run', 'warn')

      return
    }

    // Build the API boot closure (dist must exist before servers import handlers).
    if (apps.length > 0) {
      log(`📦 Discovered ${apps.length} API app(s): ${this.formatAppList(apps)}`)
      this.assertNoPortConflicts(apps)
      await this.buildApps(apps, watch)
    }

    // Warm the UI dependency closure BEFORE spawning any persistent child (turbo watch / turbo run
    // dev), so both see a warm cache and the cold-cache double-build race can't corrupt shared dist.
    if (uiApps.length > 0) {
      await this.buildUiApps(uiApps)
    }

    if (apps.length > 0) {
      await this.startAllApps(apps)
      log('🎉 All servers started!')
      this.printServerTable(apps)
      this.printRouteDump()
      log(
        `📝 Handler logs (AWS Powertools, logger.info/debug, etc.) → this terminal. Runner-only file: ${LOG_FILE_PATH}`,
      )
    }

    if (watch && this.appServers.length > 0) {
      this.setupWatch(apps)
    }

    // Frontends last: their delegated `turbo run dev` streams raw to the terminal below the BE table.
    if (uiApps.length > 0) {
      this.startUiDev(uiApps)
    }
  }

  /** Discover `apps/<app>/ui` frontends (with a `dev` script), applying the `--app` include filter. */
  private selectUiApps(include: string[] | null): DiscoveredUiApp[] {
    const uiApps = discoverUiAppsBare(this.monorepoRoot)
    const selected = include
      ? uiApps.filter((a) => {
          return include.includes(a.name)
        })
      : uiApps

    if (selected.length > 0) {
      log(
        `🎨 Discovered ${selected.length} UI app(s): ${selected
          .map((a) => {
            return a.name
          })
          .join(', ')}`,
      )
    }

    return selected
  }

  /**
   * Warm ONLY each UI's dependency closure (`<pkg>^...` — deps, excluding the UI itself, so no full
   * production `vite build`) with a cache-friendly (non-`--force`) turbo build. Non-fatal: if it
   * fails, `turbo run dev`'s own `^build` retries and surfaces the error in its streamed output.
   */
  private async buildUiApps(uiApps: DiscoveredUiApp[]): Promise<void> {
    const filters = uiApps
      .map((a) => {
        return `--filter=${a.packageName}^...`
      })
      .join(' ')

    log('🔨 Warming UI dependency build cache (turbo)...')
    try {
      await this.runBuild(`pnpm exec turbo run build ${filters} --env-mode=loose`, log)
      log('✅ UI deps built')
    } catch (error) {
      log(`⚠️  UI dep warm build failed (continuing; turbo run dev will build): ${String(error)}`, 'warn')
    }
  }

  /**
   * Start the frontends via ONE delegated `turbo run dev` child (streamed to the terminal). Reaped
   * on {@link shutdown}. Concurrency ≥ the persistent UI `dev` task count (turbo hard-errors otherwise).
   */
  private startUiDev(uiApps: DiscoveredUiApp[]): void {
    const names = uiApps
      .map((a) => {
        return a.name
      })
      .join(', ')

    log(`🎨 Starting ${uiApps.length} UI dev server(s) via \`turbo run dev\`: ${names}`)
    log('   (framework dev output streams below; each prints its own local URL)')

    this.uiDev = this.uiDevFactory({
      packageNames: uiApps.map((a) => {
        return a.packageName
      }),
      cwd: process.cwd(),
      concurrency: Math.max(uiApps.length + 4, 12),
    })
  }

  /** Render an app list as `name:port, name:port` for log lines. */
  private formatAppList(apps: Array<{ name: string; port: number }>): string {
    return apps
      .map((a) => {
        return `${a.name}:${a.port}`
      })
      .join(', ')
  }

  /** Apply the `--app` include filter (logging it when applied). */
  private selectApps(apps: IApiAppConfig[], include: string[] | null): IApiAppConfig[] {
    if (!include) {
      return apps
    }

    log(`🔍 Filtering to apps: ${include.join(', ')}`)

    return apps.filter((app) => {
      return include.includes(app.name)
    })
  }

  /** Throw (after logging remediation tips) when two apps resolve to the same port. */
  private assertNoPortConflicts(apps: IApiAppConfig[]): void {
    const { duplicatePorts, conflictingApps } = findPortConflicts(apps)

    if (duplicatePorts.length === 0) {
      return
    }

    log(`⚠️  Port conflict detected! ${duplicatePorts.join(', ')}`, 'error')
    log(`Conflicting apps: ${this.formatAppList(conflictingApps)}`, 'error')
    log('\n💡 Tip: give each app a distinct port via `{APP}_PORT` env (e.g. `CLIENT_PORT=`,', 'error')
    log('   `SEARCH_ENGINE_PORT=`) or `dev.<app>.port` in infra-kit.json; or run a subset with', 'error')
    log('   `--app=<name>,<name>`.\n', 'error')
    throw new Error(`Port conflict detected: ${duplicatePorts.join(', ')}`)
  }

  /** Build every app via turbo; rethrows the build error after logging stdout/stderr. */
  private async buildApps(apps: IApiAppConfig[], watch: boolean): Promise<void> {
    const filters = apps
      .map((a) => {
        return `--filter=${a.packageName}`
      })
      .join(' ')
    // With `--watch`, always bypass Turbo cache so `tsc` runs and `dist/` matches disk (otherwise watch restarts can be no-ops).
    const buildCmd = `pnpm exec turbo run build ${filters} --env-mode=loose${watch ? ' --force' : ''}`

    log('🔨 Building API apps (turbo)...')
    try {
      await this.runBuild(buildCmd, log)
      log('✅ Build complete')
    } catch (buildError) {
      log(`❌ Build failed: ${String(buildError)}`, 'error')
      if (buildError instanceof Error && buildError.message) {
        log(`   ${buildError.message}`, 'error')
      }
      const err = buildError as { stdout?: string; stderr?: string }

      if (err.stdout) log(`   stdout: ${err.stdout.trim()}`, 'error')
      if (err.stderr) log(`   stderr: ${err.stderr.trim()}`, 'error')
      throw buildError
    }
  }

  /**
   * Start every app concurrently, collecting the ones that boot; per-app failures are logged,
   * not fatal. Safe to parallelize because each app has a distinct port (guarded up-front) and a
   * distinct `ServerlessLocalRun`, and `startOneApp` no longer mutates cwd. Push order into
   * `appServers` is non-deterministic but nothing depends on it (the table renders from `apps`).
   */
  private async startAllApps(apps: IApiAppConfig[]): Promise<void> {
    await Promise.all(
      apps.map(async (app) => {
        try {
          const server = await this.startOneApp(app)

          if (server) {
            this.appServers.push({ app, server })
          }
        } catch (error) {
          log(`❌ Failed to start ${app.name}: ${String(error)}`, 'error')
        }
      }),
    )
  }

  private async startOneApp(app: IApiAppConfig): Promise<ServerlessLocalRun | null> {
    log(`🔄 Starting ${app.name}...`)

    // No `process.chdir` here: `ServerlessLocalRun` reads `serverless.yml` and imports the
    // compiled handler from `controllersPath` (absolute), so the runner never mutates cwd —
    // which is what makes concurrent boot/restart safe.
    const server = new ServerlessLocalRun({
      controllersPath: app.path,
      prefixUrl: app.prefixUrl,
      port: app.port,
      appName: app.name,
    })

    await server.start()
    log(`✅ ${app.name} started on port ${app.port}`)

    return server
  }

  /** Run restart jobs one after another (watch can fire faster than close + listen). */
  private scheduleRestartWork(work: () => Promise<void>): Promise<void> {
    const run = this.restartWorkChain.then(
      () => {
        return work()
      },
      () => {
        return work()
      },
    )

    this.restartWorkChain = run.catch(() => {})

    return run
  }

  private async delayPortRelease(): Promise<void> {
    await new Promise((r) => {
      return setTimeout(r, DevServerRunner.PORT_RELEASE_DELAY_MS)
    })
  }

  /**
   * Schedule a restart of the given apps (1 or N), serialized against other restarts via
   * {@link scheduleRestartWork}. A single-app dist change passes `[app]`; a dependency-package
   * dist change passes every running app. The `turbo watch` engine has already rebuilt `dist/`,
   * so the runner only bounces the fastify server(s) — no build here.
   */
  private restart(apps: IApiAppConfig[]): Promise<void> {
    return this.scheduleRestartWork(() => {
      return this.runRestart(apps)
    })
  }

  /** Resolve the requested apps to their live server slots (dropping any not running). */
  private resolveRestartTargets(apps: IApiAppConfig[]): Array<{ idx: number; app: IApiAppConfig }> {
    return apps
      .map((app) => {
        return {
          idx: this.appServers.findIndex((e) => {
            return e.app.name === app.name
          }),
          app,
        }
      })
      .filter((t) => {
        return t.idx >= 0
      })
  }

  private async runRestart(apps: IApiAppConfig[]): Promise<void> {
    const targets = this.resolveRestartTargets(apps)

    if (targets.length === 0) return

    const label = targets.length === 1 ? targets[0]!.app.name : `${targets.length} apps`

    log(`🔄 Restarting ${label}...`)
    await Promise.all(
      targets.map(async ({ idx }) => {
        try {
          await this.appServers[idx]!.server.close()
        } catch (err) {
          log(`   Close warning: ${String(err)}`, 'debug')
        }
      }),
    )

    await this.delayPortRelease()

    await Promise.all(
      targets.map(async ({ idx, app }) => {
        try {
          const newServer = await this.startOneApp(app)

          if (newServer) {
            this.appServers[idx] = { app, server: newServer }
          }
        } catch (error) {
          log(`❌ Failed to restart ${app.name}: ${String(error)}`, 'error')
        }
      }),
    )
    log(`✅ Restarted ${label}`)
  }

  /**
   * Start the long-lived `turbo watch build` engine, then watch compiled `dist/` output to
   * trigger restarts. A change under an app's `dist` restarts that app; a change under any
   * `packages/<pkg>/dist` restarts every app (editing a shared lib rewrites only the lib's
   * `dist`, so a package-dist change is the lib-rebuild signal). Restarts are build-less —
   * the engine already rebuilt `dist/`.
   */
  private setupWatch(apps: IApiAppConfig[]): void {
    this.turboWatch = this.turboWatchFactory({
      packageNames: apps.map((a) => {
        return a.packageName
      }),
      cwd: process.cwd(),
      logFile: LOG_FILE_PATH,
    })
    log('👀 Watch mode: started `turbo watch build` engine; watching dist output')

    const appDistDirs = getAppDistDirs(apps)
    const packageDistDirs = getPackageDistDirs(this.monorepoRoot)
    const allDistDirs = [...appDistDirs, ...packageDistDirs]

    if (allDistDirs.length === 0) {
      log('⚠️  No app or package dist directories found to watch (were they built?)', 'warn')

      return
    }

    const usePoll = process.env.DEV_SERVER_CHOKIDAR_POLL === '1'

    const watcher = chokidar.watch(allDistDirs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      // Ignore tsc's incremental bookkeeping + sourcemaps: they rewrite on every build
      // (even content-identical ones) and would bounce fastify onto no real change.
      ignored: (p: string): boolean => {
        return p.endsWith('.tsbuildinfo') || p.endsWith('.map')
      },
      ...(usePoll ? { usePolling: true, interval: 400 } : {}),
    })

    this.watcher = watcher

    if (usePoll) {
      log('👀 chokidar: usePolling enabled (DEV_SERVER_CHOKIDAR_POLL=1)', 'debug')
    }

    watcher.on('change', (filePath: string) => {
      log(`👀 dist change detected: ${filePath}`, 'debug')

      const change = classifyDistChange(filePath, appDistDirs, packageDistDirs)

      if (change.kind === 'package') {
        // A dependency package's dist was rebuilt — restart every app.
        this.scheduleDebounced('__packages__', () => {
          return this.restart(apps)
        })

        return
      }

      const app = apps.find((a) => {
        return path.join(a.path, 'dist') === change.app
      })

      if (!app) return

      this.scheduleDebounced(app.name, () => {
        return this.restart([app])
      })
    })

    log(`👀 Watching ${appDistDirs.length} app dist + ${packageDistDirs.length} package dist dir(s) for changes...`)
  }

  /**
   * Debounce a restart under `key`: cancel any pending timer for the same key and start
   * a fresh {@link DevServerRunner.WATCH_DEBOUNCE_MS} timer, so a burst of saves collapses
   * into one restart. Errors from the scheduled work are logged, never thrown.
   */
  private scheduleDebounced(key: string, work: () => Promise<void>): void {
    const existing = this.watchDebounceTimers.get(key)

    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.watchDebounceTimers.delete(key)
      work().catch((err) => {
        log(`Restart error (${key}): ${String(err)}`, 'error')
      })
    }, DevServerRunner.WATCH_DEBOUNCE_MS)

    this.watchDebounceTimers.set(key, timer)
  }

  /**
   * Print the running-server table. The `Base URL` column carries each app's
   * `prefixUrl` (e.g. `/api/v1`) so it is copy-pasteable — the old table showed a bare
   * `http://localhost:<port>` that 404s against prefixed handler routes. A `Health`
   * column surfaces the unprefixed `/__health` liveness URL.
   */
  private printServerTable(apps: IApiAppConfig[]): void {
    const rows = apps.map((app) => {
      return [
        app.name,
        String(app.port),
        `http://localhost:${app.port}${app.prefixUrl}`,
        `http://localhost:${app.port}/__health`,
      ]
    })

    logTable(renderTable('🖥️  Running Servers', ['App', 'Port', 'Base URL', 'Health'], rows))
  }

  /**
   * Dump each running app's registered `METHOD /path` routes at startup so the
   * emulator is self-describing (no need to open `serverless.yml` to learn the routes).
   * Reads the live route set via {@link ServerlessLocalRun.getRegisteredRoutes}.
   */
  private printRouteDump(): void {
    if (this.appServers.length === 0) return

    log('🗺️  Registered routes:')
    for (const { app, server } of this.appServers) {
      const routes = server.getRegisteredRoutes()

      log(`   ${app.name} (${routes.length}): ${routes.length > 0 ? routes.join(', ') : '(none)'}`)
    }
  }

  /**
   * Stop watching, cancel any pending debounced restart, and close all running servers.
   * Does not exit the process — the entry point owns exit.
   */
  public async shutdown(): Promise<void> {
    log('🛑 Shutting down all servers...')

    // Reap the long-lived engines FIRST (group SIGTERM→SIGKILL) so neither writes fresh dist nor
    // holds a port mid-teardown. Reaped here (not only in the entry signal handler) because tests
    // and any non-signal caller invoke shutdown() directly. Awaited so the SIGKILL escalation
    // completes before the entry point's `process.exit`.
    if (this.turboWatch) {
      await this.turboWatch.kill()
      this.turboWatch = null
    }

    if (this.uiDev) {
      await this.uiDev.kill()
      this.uiDev = null
    }

    for (const timer of this.watchDebounceTimers.values()) {
      clearTimeout(timer)
    }
    this.watchDebounceTimers.clear()

    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }

    for (const { server } of this.appServers) {
      try {
        await server.close()
      } catch {
        // ignore
      }
    }
    log(`📝 Logs saved to: ${LOG_FILE_PATH}`)
  }
}

/**
 * Construct a {@link DevServerRunner}, start it, and return the instance so the caller
 * (the CLI entry point) can wire signal handlers to `shutdown()` and own process exit.
 */
export async function run(options: DevServerOptions = {}): Promise<DevServerRunner> {
  const runner = new DevServerRunner(options)

  await runner.start()

  return runner
}
