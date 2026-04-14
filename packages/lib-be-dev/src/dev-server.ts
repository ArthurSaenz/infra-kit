#!/usr/bin/env node
/**
 * Unified Development Server Runner
 *
 * Discovers and runs API apps under each `apps/<app>/api` folder that contains `serverless.yml`.
 *
 * Ports: `{APP}_PORT`, then `process.env.PORT`, else **3010**.
 * Env vars should be provided via secrets manager (e.g. `doppler run -- pnpm dev-server`) or shell.
 *
 * From monorepo root, invoke the script your root `package.json` wires to this file, for example:
 *   tsx packages/lib-be-dev/src/devServer.ts
 *   tsx packages/lib-be-dev/src/devServer.ts --watch
 *   tsx packages/lib-be-dev/src/devServer.ts --app=client,backoffice
 *   tsx packages/lib-be-dev/src/devServer.ts --exclude=cronjobs
 *
 * Runner messages append to `packages/lib-be-dev/log.txt`. Lambda / Powertools logs from handlers go to stdout.
 */
import chokidar from 'chokidar'
import * as fs from 'fs'
import { exec } from 'node:child_process'
import util from 'node:util'
import * as path from 'path'
import { fileURLToPath } from 'url'

import { ServerlessLocalRun } from './serverlessLocalRun.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Log file path - in lib-be-dev directory
const LOG_FILE_PATH = path.join(__dirname, '..', 'log.txt')

// Create/clear log file on startup
fs.writeFileSync(LOG_FILE_PATH, `=== Dev Server Started: ${new Date().toISOString()} ===\n\n`)

const execFn = util.promisify(exec)

const launchScript = async (
  script: string,
  logFn?: (msg: string, level?: 'info' | 'warn' | 'error' | 'debug') => void,
): Promise<void> => {
  try {
    const { stderr } = await execFn(script)

    if (stderr && logFn) logFn('   (build) ' + stderr.trim(), 'debug')
    if (stderr && !logFn) console.error('stderr:', stderr)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }

    if (logFn && (err.stdout || err.stderr)) {
      if (err.stdout) logFn('   stdout: ' + err.stdout.trim(), 'error')
      if (err.stderr) logFn('   stderr: ' + err.stderr.trim(), 'error')
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
    console.log(message)
  }

  // Append to log file
  fs.appendFileSync(LOG_FILE_PATH, logLine)
}

/**
 * Write table output to both console and log file
 */
function logTable(lines: string[]): void {
  const output = lines.join('\n') + '\n'
  console.log(output)

  fs.appendFileSync(LOG_FILE_PATH, output + '\n')
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

/** Fallback port when no PORT / APP_NAME_PORT env var is set */
const FALLBACK_PORT = 3010

interface IAppServer {
  app: IApiAppConfig
  server: ServerlessLocalRun
}

class DevServerRunner {
  private readonly monorepoRoot: string
  private readonly appServers: IAppServer[] = []
  private watchDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private static readonly WATCH_DEBOUNCE_MS = 400
  /** Serialized restarts so rapid saves never bind :port while the previous server is still shutting down. */
  private restartWorkChain: Promise<void> = Promise.resolve()
  private static readonly PORT_RELEASE_DELAY_MS = 200

  constructor() {
    // Navigate from packages/lib-be-dev/src (tsx) or dist to monorepo root
    this.monorepoRoot = this.findMonorepoRoot()
    log(`Monorepo root: ${this.monorepoRoot}`)

    if (process.env['DOPPLER_PROJECT'] != null || process.env['DOPPLER_ENVIRONMENT'] != null) {
      log('🔐 Doppler env detected (DOPPLER_PROJECT / DOPPLER_ENVIRONMENT)', 'debug')
    }
  }

  private findMonorepoRoot(): string {
    let currentDir = __dirname

    for (let i = 0; i < 10; i++) {
      const workspaceFile = path.join(currentDir, 'pnpm-workspace.yaml')

      if (fs.existsSync(workspaceFile)) {
        return currentDir
      }
      currentDir = path.dirname(currentDir)
    }

    throw new Error('Could not find monorepo root (pnpm-workspace.yaml)')
  }

  private discoverApiApps(): IApiAppConfig[] {
    const appsDir = path.join(this.monorepoRoot, 'apps')
    const apps: IApiAppConfig[] = []

    if (!fs.existsSync(appsDir)) {
      throw new Error(`Apps directory not found: ${appsDir}`)
    }

    const appDirs = fs
      .readdirSync(appsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)

    for (const appName of appDirs) {
      const apiPath = path.join(appsDir, appName, 'api')
      const serverlessPath = path.join(apiPath, 'serverless.yml')

      if (fs.existsSync(serverlessPath)) {
        const port = this.getPortFromEnv(appName)
        const packageName = this.getPackageName(apiPath, appName)

        apps.push({
          name: appName,
          packageName,
          path: apiPath,
          port,
          prefixUrl: '/api/v1',
        })
      }
    }

    return apps
  }

  private getPackageName(apiPath: string, appName: string): string {
    const pkgPath = path.join(apiPath, 'package.json')

    if (!fs.existsSync(pkgPath)) return appName

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string }

      return typeof pkg.name === 'string' ? pkg.name : appName
    } catch {
      return appName
    }
  }

  private parsePortString(val: string | undefined): number | null {
    if (val == null || val === '') {
      return null
    }

    const n = parseInt(
      String(val)
        .trim()
        .replace(/^["']|["']$/g, ''),
      10,
    )

    return Number.isNaN(n) ? null : n
  }

  /**
   * Read PORT for an API app.
   *
   * 1. **`process.env.{APP}_PORT`** — e.g. `CLIENT_PORT`, `SEARCH_ENGINE_PORT` (secrets manager or shell)
   * 2. **`process.env.PORT`** — shared fallback (multi-app: use distinct `{APP}_PORT` in env)
   * 3. Default **3010**
   *
   * Per-app keys use the app folder name in **UPPER_SNAKE_CASE** (hyphens → underscores).
   */
  private getPortFromEnv(appName: string): number {
    const prefix = appName.replace(/-/g, '_').toUpperCase()
    const prefixedKey = `${prefix}_PORT`

    const fromPrefixed = this.parsePortString(process.env[prefixedKey])
    if (fromPrefixed != null) {
      return fromPrefixed
    }

    const fromPort = this.parsePortString(process.env['PORT'])

    if (fromPort != null) {
      return fromPort
    }

    return FALLBACK_PORT
  }

  private parseArgs(): {
    include: string[] | null
    exclude: string[] | null
    watch: boolean
  } {
    const args = process.argv.slice(2)
    const include: string[] = []
    const exclude: string[] = []
    let watch = false

    for (const arg of args) {
      if (arg === '--watch' || arg === '-w') {
        watch = true
      } else if (arg.startsWith('--app=')) {
        include.push(...arg.replace('--app=', '').split(','))
      } else if (arg.startsWith('--exclude=')) {
        exclude.push(...arg.replace('--exclude=', '').split(','))
      }
    }

    return {
      include: include.length > 0 ? include : null,
      exclude: exclude.length > 0 ? exclude : null,
      watch,
    }
  }

  public async start(): Promise<void> {
    const { include, exclude, watch } = this.parseArgs()

    process.env['POWERTOOLS_DEV'] ??= 'true'
    process.env['LOG_LEVEL'] ??= 'DEBUG'

    log('🚀 Starting Development Server Runner')

    if (watch) {
      log('👀 Watch mode: will rebuild and restart on file save')
    }
    log(`📂 Monorepo root: ${this.monorepoRoot}`)

    let apps = this.discoverApiApps()

    if (include) {
      apps = apps.filter((app) => include.includes(app.name))
      log(`🔍 Filtering to apps: ${include.join(', ')}`)
    }
    if (exclude) {
      apps = apps.filter((app) => !exclude.includes(app.name))
      log(`🚫 Excluding apps: ${exclude.join(', ')}`)
    }

    if (apps.length === 0) {
      log('⚠️  No API apps found to run', 'warn')
      return
    }

    log(`📦 Discovered ${apps.length} API app(s): ${apps.map((a) => `${a.name}:${a.port}`).join(', ')}`)

    const ports = apps.map((a) => a.port)
    const duplicatePorts = ports.filter((port, index) => ports.indexOf(port) !== index)

    if (duplicatePorts.length > 0) {
      log('⚠️  Port conflict detected! ' + duplicatePorts.join(', '), 'error')
      const conflictingApps = apps.filter((a) => duplicatePorts.includes(a.port))
      log('Conflicting apps: ' + conflictingApps.map((a) => `${a.name}:${a.port}`).join(', '), 'error')
      log('\n💡 Tip: Set distinct env vars like `CLIENT_PORT=`, `SEARCH_ENGINE_PORT=`, …', 'error')
      log('   Or use --exclude=appname to skip conflicting apps\n', 'error')
      process.exit(1)
    }

    // With `--watch`, always bypass Turbo cache so `tsc` runs and `dist/` matches disk (otherwise watch restarts can be no-ops).
    const buildCmd = `pnpm exec turbo run build ${apps.map((a) => `--filter=${a.packageName}`).join(' ')} --env-mode=loose${watch ? ' --force' : ''}`
    log('🔨 Building API apps (turbo)...')
    try {
      await launchScript(buildCmd, log)
      log('✅ Build complete')
    } catch (buildError) {
      log('❌ Build failed: ' + String(buildError), 'error')
      if (buildError instanceof Error && buildError.message) {
        log('   ' + buildError.message, 'error')
      }
      const err = buildError as { stdout?: string; stderr?: string }
      if (err.stdout) log('   stdout: ' + err.stdout.trim(), 'error')
      if (err.stderr) log('   stderr: ' + err.stderr.trim(), 'error')
      process.exit(1)
    }

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

    log('🎉 All servers started!')
    this.printServerTable(apps)
    log(`📝 Handler logs (AWS Powertools, logger.info/debug, etc.) → this terminal. Runner-only file: ${LOG_FILE_PATH}`)

    if (watch && this.appServers.length > 0) {
      this.setupWatch(apps)
    }

    process.on('SIGINT', () => {
      this.shutdown().catch(() => process.exit(1))
    })
    process.on('SIGTERM', () => {
      this.shutdown().catch(() => process.exit(1))
    })
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
      () => work(),
      () => work(),
    )
    this.restartWorkChain = run.catch(() => {})
    return run
  }

  private async delayPortRelease(): Promise<void> {
    await new Promise((r) => setTimeout(r, DevServerRunner.PORT_RELEASE_DELAY_MS))
  }

  private restartApp(app: IApiAppConfig): Promise<void> {
    return this.scheduleRestartWork(() => this.runRestartApp(app))
  }

  private async runRestartApp(app: IApiAppConfig): Promise<void> {
    const idx = this.appServers.findIndex((e) => e.app.name === app.name)
    if (idx < 0) return

    const entry = this.appServers[idx]
    if (!entry) return

    log(`🔄 Rebuilding ${app.name}...`, 'debug')
    try {
      await launchScript(`pnpm exec turbo run build --filter=${app.packageName} --env-mode=loose --force`)
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
    return this.scheduleRestartWork(() => this.runRestartAllApps())
  }

  private async runRestartAllApps(): Promise<void> {
    log('📦 Lib/package changed — rebuilding all apps...')

    try {
      await launchScript(
        `pnpm exec turbo run build ${this.appServers.map((a) => `--filter=${a.app.packageName}`).join(' ')} --env-mode=loose --force`,
      )
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

  private getPackageSrcDirs(): string[] {
    const packagesDir = path.join(this.monorepoRoot, 'packages')

    if (!fs.existsSync(packagesDir)) return []

    const names = fs
      .readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
    const dirs: string[] = []

    for (const name of names) {
      const srcDir = path.join(packagesDir, name, 'src')
      if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
        dirs.push(srcDir)
      }
    }
    return dirs
  }

  private setupWatch(apps: IApiAppConfig[]): void {
    const appSrcDirs = apps
      .map((app) => ({
        app,
        dir: path.join(app.path, 'src'),
      }))
      .filter(({ dir }) => fs.existsSync(dir))

    const packageSrcDirs = this.getPackageSrcDirs()
    const allWatchDirs = [...appSrcDirs.map((d) => d.dir), ...packageSrcDirs]

    if (allWatchDirs.length === 0) {
      log('⚠️  No app or package src directories found to watch', 'warn')
      return
    }

    const usePoll = process.env['DEV_SERVER_CHOKIDAR_POLL'] === '1'

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
      const normalized = path.normalize(filePath)

      const inPackage = packageSrcDirs.some((dir) => normalized.startsWith(path.normalize(dir)))

      if (inPackage) {
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

      const pair = appSrcDirs.find(({ dir }) => normalized.startsWith(path.normalize(dir)))
      if (!pair) return

      const key = pair.app.name
      const existing = this.watchDebounceTimers.get(key)
      if (existing) clearTimeout(existing)

      const timer = setTimeout(() => {
        this.watchDebounceTimers.delete(key)
        this.restartApp(pair.app).catch((err) => {
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

  private async shutdown(): Promise<void> {
    log('🛑 Shutting down all servers...')
    for (const { server } of this.appServers) {
      try {
        await server.close()
      } catch {
        // ignore
      }
    }
    log(`📝 Logs saved to: ${LOG_FILE_PATH}`)
    process.exit(0)
  }
}

// Run the server if this is the main module
const runner = new DevServerRunner()
runner.start().catch((error) => {
  log('❌ Failed to start dev server: ' + String(error), 'error')
  if (error instanceof Error && error.stack) {
    log('Stack: ' + error.stack, 'error')
  }
  log(`📝 Logs saved to: ${LOG_FILE_PATH}`, 'error')
  process.exit(1)
})
