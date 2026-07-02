/**
 * Unified Development Server Runner
 *
 * Discovers and runs API apps under each `apps/<app>/api` folder that contains `serverless.yml`.
 *
 * Ports: `--port` flag, then `{APP}_PORT`, then `process.env.PORT`, then `dev.<app>.port`
 * from infra-kit.json, else 3010. URL prefix: `dev.<app>.prefixUrl`, else `/api/v1`.
 * Env vars should be provided via secrets manager (e.g. `doppler run -- pnpm dev-server`) or shell.
 *
 * This module is side-effect free on import: call `run()` (or construct `DevServerRunner`
 * directly) to start. Signal handling and process exit are the entry point's responsibility.
 *
 * Runner messages append to `<cwd>/.infra-kit/dev-server.log`. Lambda / Powertools logs from
 * handlers go to stdout.
 */
import chokidar from 'chokidar'
import { exec } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import util from 'node:util'

import type { DevConfig } from 'src/lib/infra-kit-config'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'

import {
  classifyChange,
  discoverApiApps as discoverApiAppsBare,
  findMonorepoRoot,
  getAppSrcDirs,
  getPackageSrcDirs,
  normalizeAppFilters as normalizeAppFiltersPure,
} from './discovery.js'
import { findPortConflicts, resolvePort as resolvePortPure, resolvePrefixUrl as resolvePrefixUrlPure } from './ports.js'
import { ServerlessLocalRun } from './serverless-local-run.js'

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

/**
 * Write a message to both console and log file
 */
function log(message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info'): void {
  const timestamp = new Date().toISOString()
  const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`

  // Write to console
  if (level === 'error') {
    console.error(message)
  } else if (level === 'warn') {
    console.warn(message)
  } else {
    process.stdout.write(`${message}\n`)
  }

  // Append to log file
  fs.appendFileSync(LOG_FILE_PATH, logLine)
}

/**
 * Write table output to both console and log file
 */
function logTable(lines: string[]): void {
  const output = `${lines.join('\n')}\n`

  process.stdout.write(`${output}\n`)

  fs.appendFileSync(LOG_FILE_PATH, `${output}\n`)
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
 * Runner options, parsed by the CLI entry point (`--watch`, `--app`, `--exclude`,
 * `--port`) and threaded through `run()`. The entry owns flag parsing; the runner
 * never reads `process.argv` itself.
 */
export interface DevServerOptions {
  /** Rebuild + restart on file save. */
  watch?: boolean
  /** Only run these app folder names (null/empty = all discovered). */
  include?: string[] | null
  /** Skip these app folder names. */
  exclude?: string[] | null
  /** Explicit port override — beats every env/config source for every app. */
  port?: number
}

interface IAppServer {
  app: IApiAppConfig
  server: ServerlessLocalRun
}

export class DevServerRunner {
  private readonly monorepoRoot: string
  private readonly appServers: IAppServer[] = []
  private watchDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private static readonly WATCH_DEBOUNCE_MS = 400
  /** Serialized restarts so rapid saves never bind :port while the previous server is still shutting down. */
  private restartWorkChain: Promise<void> = Promise.resolve()
  private static readonly PORT_RELEASE_DELAY_MS = 200
  private readonly options: DevServerOptions
  /** Build runner seam — real turbo shell-out by default, injectable for tests. */
  private readonly runBuild: BuildRunner

  constructor(options: DevServerOptions = {}, runBuild: BuildRunner = launchScript) {
    this.options = options
    this.runBuild = runBuild
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

  /** Thin delegator to the pure {@link normalizeAppFiltersPure} over the runner's options. */
  private normalizeAppFilters(): { include: string[] | null; exclude: string[] | null } {
    return normalizeAppFiltersPure({ include: this.options.include, exclude: this.options.exclude })
  }

  /** Thin delegator to the pure {@link resolvePortPure}, threading env + the `--port` override. */
  private resolvePort(appName: string, devConfig: DevConfig): number {
    return resolvePortPure(appName, process.env, devConfig, this.options.port)
  }

  /** Thin delegator to the pure {@link resolvePrefixUrlPure}. */
  private resolvePrefixUrl(appName: string, devConfig: DevConfig): string {
    return resolvePrefixUrlPure(appName, devConfig)
  }

  public async start(): Promise<void> {
    const { include, exclude } = this.normalizeAppFilters()
    const watch = this.options.watch ?? false
    const devConfig = await this.loadDevConfig()

    process.env.POWERTOOLS_DEV ??= 'true'
    process.env.LOG_LEVEL ??= 'DEBUG'

    log('🚀 Starting Development Server Runner')

    if (watch) {
      log('👀 Watch mode: will rebuild and restart on file save')
    }
    log(`📂 Monorepo root: ${this.monorepoRoot}`)

    const apps = this.selectApps(this.discoverApiApps(devConfig), include, exclude)

    if (apps.length === 0) {
      log('⚠️  No API apps found to run', 'warn')

      return
    }

    log(`📦 Discovered ${apps.length} API app(s): ${this.formatAppList(apps)}`)

    this.assertNoPortConflicts(apps)

    await this.buildApps(apps, watch)
    await this.startAllApps(apps)

    log('🎉 All servers started!')
    this.printServerTable(apps)
    log(`📝 Handler logs (AWS Powertools, logger.info/debug, etc.) → this terminal. Runner-only file: ${LOG_FILE_PATH}`)

    if (watch && this.appServers.length > 0) {
      this.setupWatch(apps)
    }
  }

  /** Render an app list as `name:port, name:port` for log lines. */
  private formatAppList(apps: Array<{ name: string; port: number }>): string {
    return apps
      .map((a) => {
        return `${a.name}:${a.port}`
      })
      .join(', ')
  }

  /** Apply the `--app`/`--exclude` filters (logging each applied filter). */
  private selectApps(apps: IApiAppConfig[], include: string[] | null, exclude: string[] | null): IApiAppConfig[] {
    let selected = apps

    if (include) {
      selected = selected.filter((app) => {
        return include.includes(app.name)
      })
      log(`🔍 Filtering to apps: ${include.join(', ')}`)
    }
    if (exclude) {
      selected = selected.filter((app) => {
        return !exclude.includes(app.name)
      })
      log(`🚫 Excluding apps: ${exclude.join(', ')}`)
    }

    return selected
  }

  /** Throw (after logging remediation tips) when two apps resolve to the same port. */
  private assertNoPortConflicts(apps: IApiAppConfig[]): void {
    const { duplicatePorts, conflictingApps } = findPortConflicts(apps)

    if (duplicatePorts.length === 0) {
      return
    }

    log(`⚠️  Port conflict detected! ${duplicatePorts.join(', ')}`, 'error')
    log(`Conflicting apps: ${this.formatAppList(conflictingApps)}`, 'error')
    log('\n💡 Tip: Set distinct env vars like `CLIENT_PORT=`, `SEARCH_ENGINE_PORT=`, …', 'error')
    log('   Or use --exclude=appname to skip conflicting apps\n', 'error')
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

  /** Start each app in turn, collecting the ones that boot; per-app failures are logged, not fatal. */
  private async startAllApps(apps: IApiAppConfig[]): Promise<void> {
    for (const app of apps) {
      try {
        const server = await this.startOneApp(app)

        if (server) {
          this.appServers.push({ app, server })
        }
      } catch (error) {
        log(`❌ Failed to start ${app.name}: ${String(error)}`, 'error')
      }
    }
  }

  private async startOneApp(app: IApiAppConfig): Promise<ServerlessLocalRun | null> {
    log(`🔄 Starting ${app.name}...`)

    const originalCwd = process.cwd()

    process.chdir(app.path)

    try {
      const server = new ServerlessLocalRun({
        controllersPath: app.path,
        prefixUrl: app.prefixUrl,
        port: app.port,
        appName: app.name,
      })

      await server.start()
      log(`✅ ${app.name} started on port ${app.port}`)

      return server
    } finally {
      process.chdir(originalCwd)
    }
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

  private restartApp(app: IApiAppConfig): Promise<void> {
    return this.scheduleRestartWork(() => {
      return this.runRestartApp(app)
    })
  }

  private async runRestartApp(app: IApiAppConfig): Promise<void> {
    const idx = this.appServers.findIndex((e) => {
      return e.app.name === app.name
    })

    if (idx < 0) return

    const entry = this.appServers[idx]

    if (!entry) return

    log(`🔄 Rebuilding ${app.name}...`, 'debug')
    try {
      await this.runBuild(`pnpm exec turbo run build --filter=${app.packageName} --env-mode=loose --force`)
    } catch {
      log(`⚠️  Build failed for ${app.name}, skipping restart`, 'warn')

      return
    }
    log(`🔄 Restarting ${app.name}...`)
    try {
      await entry.server.close()
    } catch (err) {
      log(`   Close warning: ${String(err)}`, 'debug')
    }
    await this.delayPortRelease()
    try {
      const newServer = await this.startOneApp(app)

      if (newServer) {
        this.appServers[idx] = { app, server: newServer }
      }
    } catch (error) {
      log(`❌ Failed to restart ${app.name}: ${String(error)}`, 'error')
    }
  }

  private restartAllApps(): Promise<void> {
    return this.scheduleRestartWork(() => {
      return this.runRestartAllApps()
    })
  }

  private async runRestartAllApps(): Promise<void> {
    log('📦 Lib/package changed — rebuilding all apps...')

    const filters = this.appServers
      .map((a) => {
        return `--filter=${a.app.packageName}`
      })
      .join(' ')

    try {
      await this.runBuild(`pnpm exec turbo run build ${filters} --env-mode=loose --force`)
    } catch {
      log('⚠️  Build failed for all apps, skipping restart', 'warn')

      return
    }

    for (let i = 0; i < this.appServers.length; i++) {
      try {
        await this.appServers[i]!.server.close()
      } catch (err) {
        log(`   Close warning: ${String(err)}`, 'debug')
      }
    }

    await this.delayPortRelease()

    for (let i = 0; i < this.appServers.length; i++) {
      const { app } = this.appServers[i]!

      try {
        const newServer = await this.startOneApp(app)

        if (newServer) {
          this.appServers[i] = { app, server: newServer }
        }
      } catch (error) {
        log(`❌ Failed to restart ${app.name}: ${String(error)}`, 'error')
      }
    }
    log('✅ All apps rebuilt and restarted')
  }

  private setupWatch(apps: IApiAppConfig[]): void {
    const appSrcDirs = getAppSrcDirs(apps)
    const packageSrcDirs = getPackageSrcDirs(this.monorepoRoot)
    const allWatchDirs = [...appSrcDirs, ...packageSrcDirs]

    if (allWatchDirs.length === 0) {
      log('⚠️  No app or package src directories found to watch', 'warn')

      return
    }

    const usePoll = process.env.DEV_SERVER_CHOKIDAR_POLL === '1'

    const watcher = chokidar.watch(allWatchDirs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      ...(usePoll ? { usePolling: true, interval: 400 } : {}),
    })

    if (usePoll) {
      log('👀 chokidar: usePolling enabled (DEV_SERVER_CHOKIDAR_POLL=1)', 'debug')
    }

    watcher.on('change', (filePath: string) => {
      log(`👀 Change detected: ${filePath}`, 'debug')

      const change = classifyChange(filePath, appSrcDirs, packageSrcDirs)

      if (change.kind === 'package') {
        const key = '__packages__'
        const existing = this.watchDebounceTimers.get(key)

        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          this.watchDebounceTimers.delete(key)
          this.restartAllApps().catch((err) => {
            log(`Restart all error: ${String(err)}`, 'error')
          })
        }, DevServerRunner.WATCH_DEBOUNCE_MS)

        this.watchDebounceTimers.set(key, timer)

        return
      }

      const app = apps.find((a) => {
        return path.join(a.path, 'src') === change.app
      })

      if (!app) return

      const key = app.name
      const existing = this.watchDebounceTimers.get(key)

      if (existing) clearTimeout(existing)

      const timer = setTimeout(() => {
        this.watchDebounceTimers.delete(key)
        this.restartApp(app).catch((err) => {
          log(`Restart error: ${String(err)}`, 'error')
        })
      }, DevServerRunner.WATCH_DEBOUNCE_MS)

      this.watchDebounceTimers.set(key, timer)
    })

    log(`👀 Watching ${appSrcDirs.length} app(s) + ${packageSrcDirs.length} package(s) for changes...`)
  }

  private printServerTable(apps: IApiAppConfig[]): void {
    const lines = [
      '',
      '┌──────────────────────────────────────────────────────────────┐',
      '│                    🖥️  Running Servers                       │',
      '├──────────────────────────┬───────┬───────────────────────────┤',
      '│ App                      │ Port  │ URL                       │',
      '├──────────────────────────┼───────┼───────────────────────────┤',
    ]

    for (const app of apps) {
      const name = app.name.padEnd(24)
      const port = String(app.port).padEnd(5)
      const url = `http://localhost:${app.port}`.padEnd(25)

      lines.push(`│ ${name} │ ${port} │ ${url} │`)
    }

    lines.push('└──────────────────────────┴───────┴───────────────────────────┘')
    lines.push('')

    logTable(lines)
  }

  /** Close all running servers. Does not exit the process — the entry point owns exit. */
  public async shutdown(): Promise<void> {
    log('🛑 Shutting down all servers...')
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
