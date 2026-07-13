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
 * Runner messages append to the session log `<cacheRoot>/<INFRA_KIT_SESSION>/logs.txt`. Lambda / Powertools logs from
 * handlers go to stdout.
 */
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { exec, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import util from 'node:util'

import { INFRA_KIT_SESSION_VAR, getCacheRoot } from 'src/lib/constants'
import type { DevConfig, DevPreset, DevPresets } from 'src/lib/infra-kit-config'
import { DEFAULT_DEV_PROXY_PORT, getInfraKitConfig } from 'src/lib/infra-kit-config'
import { DEFAULT_RELEASE_SLUG, slugifyHostLabel, slugifyRelease } from 'src/lib/release-slug'

import { buildClosureMap, packageDebounceKey, selectPackageRestartTargets } from './dep-closure.js'
import type { ClosureMap, DryRunner } from './dep-closure.js'
import type { DevUi } from './dev-ui.js'
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
import {
  findPortConflicts,
  resolvePreferredPort as resolvePreferredPortPure,
  resolvePrefixUrl as resolvePrefixUrlPure,
} from './ports.js'
import { deriveTargetLabel, resolvePreset } from './presets.js'
import { createPortlessDriver, formatPortlessCommand, readCaPath } from './proxy/portless-driver.js'
import type { PortlessDriver } from './proxy/portless-driver.js'
import { DevRenderer, resolveEndpointUrl } from './render.js'
import type { EndpointRow, UiRef } from './render.js'
import { ServerlessLocalRun } from './serverless-local-run.js'
import { defaultTurboWatchFactory } from './turbo-watch.js'
import type { TurboWatchFactory, TurboWatchHandle } from './turbo-watch.js'
import { defaultUiDevFactory } from './ui-dev.js'
import type { UiDevFactory, UiDevHandle } from './ui-dev.js'

/** Runner-only log file, resolved under the session cache dir (`<cacheRoot>/<session>/logs.txt`) at startup. */
let LOG_FILE_PATH = resolveLogFilePath()

/**
 * Resolve `<cacheRoot>/<INFRA_KIT_SESSION>/logs.txt`. Reuses infra-kit's own per-terminal session id
 * (the same dir that holds the session's `env-load.sh`), falling back to a literal `no-session` folder
 * when the shell hasn't exported one — so dev logging never depends on `infra-kit init` having run.
 * Built from {@link getCacheRoot} (never `getSessionCacheDir`, which throws when the session is unset).
 */
export function resolveLogFilePath(): string {
  return path.join(getCacheRoot(), process.env[INFRA_KIT_SESSION_VAR] ?? 'no-session', 'logs.txt')
}

/** Resolve the session log path, ensure the dir exists, and clear the file. */
function initLogFile(): void {
  LOG_FILE_PATH = resolveLogFilePath()
  fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true })
  fs.writeFileSync(LOG_FILE_PATH, `=== Dev Server Started: ${new Date().toISOString()} ===\n\n`)
}

/** Replace a leading home dir with `~` for a compact, human-readable path label (the on-screen log link). */
export function homeShorten(p: string): string {
  const home = os.homedir()

  return p === home || p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p
}

/**
 * Comma-joined package names — not folder names, so a boot line names the exact `turbo --filter`
 * targets the build runs on and matches turbo's own output.
 */
function packageList(apps: { packageName: string }[]): string {
  return apps
    .map((a) => {
      return a.packageName
    })
    .join(', ')
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

/** Append raw text to the runner-only log file (the single tee-to-file seam the renderer wraps). */
function appendLogFile(text: string): void {
  fs.appendFileSync(LOG_FILE_PATH, text)
}

/**
 * An OS-assigned free TCP port on 127.0.0.1 — used to pre-assign each UI's Vite port so the runner can
 * print its URL (and alias it, when a proxy is up) before Vite binds. Probes then releases (small TOCTOU
 * window; `strictPort` on the Vite side turns a rare lost race into a loud failure rather than a silent drift).
 */
const getFreePort = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()

    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0

      srv.close(() => {
        return resolve(port)
      })
    })
  })
}

interface IApiAppConfig {
  /** App folder name (e.g. backoffice, client) */
  name: string
  /** Package name from package.json (e.g. sls-trvl-client) */
  packageName: string
  path: string
  /**
   * EXPLICITLY-configured preferred port (`{APP}_PORT`/`PORT`/`dev.<app>.port`), or
   * `undefined` when unconfigured. Under dynamic allocation this is only a bind hint — the
   * ACTUAL port is the ephemeral one bound at start time (see {@link IAppServer.boundPort}).
   */
  preferredPort: number | undefined
  prefixUrl: string
  /**
   * Whether this backend participates in dependency-closure watching (plan Phase 1): in
   * `--watch`, a rebuild of a package in this app's closure restarts it. Default `true`;
   * a preset `watchDeps: false` opts out (sticky). Resolved from the preset in {@link run}.
   */
  watchDeps: boolean
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
   * Named dev preset (`infra-kit dev <preset>`) from `devServersPresets` in the project's infra-kit config.
   * It selects the launch targets (`apps/<app>/{api,ui}`); resolved by {@link file://./presets.ts}.
   * Unset → run everything (`*`). `include` (`--app`/`--self`) further narrows the resolved set.
   */
  preset?: string
  /**
   * In-memory preset definition, produced by the interactive wizard (`infra-kit dev` with no args in a
   * TTY). When set it is used verbatim as the run plan — it WINS over `preset` (the named lookup) and
   * the default `*`. This is how the wizard expresses part-level selection (`<app>/ui` without
   * `<app>/api`), which `include` (app-name-only) cannot. Unset on every non-wizard invocation.
   */
  presetDef?: DevPreset
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
  /**
   * Print the full boot narration (build/discovery/watch steps) to the terminal. Default false:
   * the terminal shows only the server panel, warnings, errors, and restart lines. The FULL detail
   * is written to the session log (`<cacheRoot>/<INFRA_KIT_SESSION>/logs.txt`) regardless of this flag.
   */
  verbose?: boolean
  /**
   * Print each app's registered `METHOD /path` route table at startup. Default false — the route
   * dump is opt-in so the calm default screen stays glanceable; the routes are always in the log.
   */
  routes?: boolean
  /**
   * Interactive TTY (both stdin+stdout). Set by the entry point; gates the Ink boot UI in {@link run}.
   * When unset, {@link run} falls back to `process.stdout.isTTY`. The runner itself never reads it.
   */
  tty?: boolean
  /**
   * Structured `--json` / MCP mode. When true, {@link run} forces the plain {@link DevRenderer} — Ink
   * must never seize a machine-readable stream. The runner itself never reads it.
   */
  json?: boolean
  /**
   * Background liveness-probe interval in ms (default {@link DevServerRunner.LIVENESS_INTERVAL_MS}, 5000).
   * A test seam only — lets a test drive the monitor loop fast; production never sets it.
   */
  livenessIntervalMs?: number
}

/** Health-probe seam: resolve an endpoint's liveness. Injectable so `ready()` stays deterministic in tests. */
export type HealthProbe = (url: string) => Promise<boolean>

/** Default probe: a bounded GET against the `/__health` URL; any non-2xx / network error → down. */
const defaultHealthProbe: HealthProbe = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })

    return res.ok
  } catch {
    return false
  }
}

interface IAppServer {
  app: IApiAppConfig
  server: ServerlessLocalRun
  /** The ACTUAL port bound at start (ephemeral or preferred), reported by `server.start()`. */
  boundPort: number
  /** Layer-B alias host (`<release>.<package>.localhost`) — the app's only address. */
  alias: string
}

/**
 * One `.infra-kit/dev-context/<app>.json` fragment. `package` (feeds the vite helper's
 * `readLocalSet`) is the app's package name; `port` is the ACTUAL bound port (the writer
 * IS the binder). `release` lets the helper prefer the runner-recorded slug over its own
 * git derivation; `pid`/`writtenAt` are staleness metadata.
 *
 * `alias` is the registered portless hostname, and `origin` is **the authoritative local target** — the
 * exact origin the helper must proxy to, published by the runner rather than re-derived by the helper from
 * a template in a separately-versioned repo. The runner is the only party that knows what it actually
 * registered, so it says so; the helper obeys.
 *
 * `proxyPort` is deliberately NOT written any more. The CLI self-updates while `infra-kit/vite` stays
 * pinned per consumer, so a new CLI routinely meets an OLD helper — and that helper's `withProxyPort`
 * grafts any port other than 80 onto its target. Writing `proxyPort: 443` would therefore have produced
 * `http://<alias>:443`: **plain HTTP into a TLS listener**, silently. Omitting the field leaves the old
 * helper's target ungrafted instead. (That is not by itself a loud failure — `:80` is bound by portless's
 * redirect server, so it 302s rather than refusing — which is why the CLI-side version floor, not this
 * omission, is the load-bearing skew guard.)
 */
interface DevContextFragment {
  package: string
  port: number
  pid: number
  writtenAt: number
  release: string
  alias: string
  origin: string
}

/**
 * Lowest published `infra-kit` whose `infra-kit/vite` helper understands the fragment's `origin` field.
 *
 * This is the load-bearing guard against version skew, and skew here is GUARANTEED rather than
 * hypothetical: the CLI is installed globally and **self-updates silently**, while `infra-kit/vite` is
 * PINNED in each consumer's `node_modules`. So a new CLI routinely meets an old helper. An old helper
 * ignores `origin` and rebuilds the target from the consumer's `templates.local` — which still says
 * `http://` — and then proxies plain HTTP at a TLS listener. That failure is silent (portless answers :80
 * with a 302 rather than refusing), so nothing downstream would catch it. Refuse at start instead.
 */
export const HELPER_VERSION_FLOOR = '0.1.132'

/** `true` when `version` sorts strictly below `floor` (numeric, dot-separated; missing parts are 0). */
export const isBelowVersion = (version: string, floor: string): boolean => {
  const parse = (v: string): number[] => {
    return v.split('.').map((part) => {
      return Number.parseInt(part, 10) || 0
    })
  }
  const a = parse(version)
  const b = parse(floor)

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0

    if (left !== right) return left < right
  }

  return false
}

/** Does any package.json in the repo declare `infra-kit` as a dependency? */
const declaresInfraKit = (repoRoot: string): boolean => {
  const manifests = [path.join(repoRoot, 'package.json')]

  try {
    for (const app of fs.readdirSync(path.join(repoRoot, 'apps'), { withFileTypes: true })) {
      if (!app.isDirectory()) continue
      for (const part of ['api', 'ui']) manifests.push(path.join(repoRoot, 'apps', app.name, part, 'package.json'))
    }
  } catch {
    // No `apps/` dir — the root manifest alone decides.
  }

  return manifests.some((file) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, Record<string, string> | undefined>

      return ['dependencies', 'devDependencies'].some((field) => {
        return pkg[field]?.['infra-kit'] != null
      })
    } catch {
      return false
    }
  })
}

/**
 * Refuse to start against a consumer-pinned `infra-kit/vite` older than {@link HELPER_VERSION_FLOOR}.
 *
 * Three branches, and the reasoning for each matters:
 * - **Workspace-linked → SKIP.** In this repo `node_modules/infra-kit` symlinks to `apps/infra-kit/cli`,
 *   whose version is the unreleased working tree. Enforcing a floor there would brick `infra-kit dev` on
 *   the very repo that develops it.
 * - **Declared but unresolvable → THROW (fail closed).** The consumer says it uses the helper and we
 *   cannot prove which one; guessing is how the silent case ships.
 * - **Not a dependency at all → SKIP.** No `infra-kit` dependency means no `infra-kit/vite` in play, so
 *   there is no helper to be skewed against. (This is also what keeps bare test fixtures runnable.)
 */
export const assertHelperVersionFloor = (repoRoot: string): void => {
  const helperDir = path.join(repoRoot, 'node_modules', 'infra-kit')

  if (!fs.existsSync(helperDir)) {
    if (!declaresInfraKit(repoRoot)) return

    throw new Error(
      `infra-kit dev: this repo depends on infra-kit but node_modules/infra-kit is missing, so the ` +
        `\`infra-kit/vite\` helper version cannot be verified. Run \`pnpm install\`.`,
    )
  }

  // Resolve BOTH sides before comparing: on macOS a temp path realpaths from `/var` to `/private/var`, so
  // an unresolved root would never contain a resolved child and a workspace link would be misread as a
  // published install.
  try {
    const real = fs.realpathSync(helperDir)
    const root = fs.realpathSync(repoRoot)

    if (real.startsWith(root + path.sep) && !real.includes(`${path.sep}node_modules${path.sep}`)) return
  } catch {
    // Fall through to the version read.
  }

  let version: string

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(helperDir, 'package.json'), 'utf-8')) as { version?: string }

    if (typeof pkg.version !== 'string') throw new Error('no version field')
    version = pkg.version
  } catch {
    throw new Error(
      'infra-kit dev: could not read the version of the pinned `infra-kit/vite` helper ' +
        '(node_modules/infra-kit/package.json). Refusing to start rather than risk proxying plain HTTP at a ' +
        'TLS listener. Run `pnpm install`.',
    )
  }

  if (isBelowVersion(version, HELPER_VERSION_FLOOR)) {
    throw new Error(
      `infra-kit dev: this repo pins infra-kit ${version}, but dev URLs are now HTTPS and the ` +
        `\`infra-kit/vite\` helper only understands them from ${HELPER_VERSION_FLOOR}. An older helper would ` +
        `proxy plain HTTP at a TLS listener — silently. Bump the dependency:\n` +
        `    pnpm add -D infra-kit@^${HELPER_VERSION_FLOOR}`,
    )
  }
}

/**
 * Slugified `<release>` for the app's git branch (resolved from the app's own dir), falling back to
 * {@link DEFAULT_RELEASE_SLUG} outside a git repo / on an empty slug. Never throws.
 *
 * A release ALWAYS resolves because it is the first DNS label of every alias, and every app is reached
 * by hostname. The fallback cannot collide the way a branch can: worktrees are what make two checkouts
 * coexist, and a worktree is by definition inside a git repo.
 */
const readAppRelease = (cwd: string): string => {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8' }).trim()
    const slug = slugifyRelease(branch)

    return slug === '' ? DEFAULT_RELEASE_SLUG : slug
  } catch {
    return DEFAULT_RELEASE_SLUG
  }
}

/**
 * The one-line `reason` for a `● failed` row. Endpoint rows are a single terminal line, so a stack
 * trace cannot go there — it is already in the log tail and the session log. Take the message only,
 * and its first line at that: validation errors like to append their own multi-line dumps.
 *
 * @example
 * errorReason(new Error("config is missing field: 'connectionURL'\n  at …")) // "config is missing field: 'connectionURL'"
 */
const errorReason = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n')[0]?.trim() ?? ''

  return firstLine === '' ? 'unknown error (see the log)' : firstLine
}

export class DevServerRunner {
  private readonly monorepoRoot: string
  /**
   * `<cwd>/.infra-kit/dev-context` — the fragment directory this runner writes its own
   * per-app `<app>.json` into (mirrors {@link LOG_FILE_PATH}'s cwd-relative resolution). The
   * `infra-kit/vite` helper searches up-tree for this dir and merges the fragments.
   */
  private readonly devContextDir: string
  private readonly appServers: IAppServer[] = []
  private watchDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  /** Active chokidar watcher in `--watch` mode; closed on {@link shutdown}. */
  private watcher: FSWatcher | null = null
  private static readonly WATCH_DEBOUNCE_MS = 400
  /** Serialized restarts so rapid saves never bind :port while the previous server is still shutting down. */
  private restartWorkChain: Promise<void> = Promise.resolve()
  private static readonly PORT_RELEASE_DELAY_MS = 200
  /** Self-rescheduling backend liveness probe; cleared on {@link shutdown}. Null when unarmed (UI-only). */
  private livenessTimer: ReturnType<typeof setTimeout> | null = null
  /** Consecutive `/__health` failures per app NAME (survives an ephemeral-port rebind on restart). */
  private readonly livenessFailures = new Map<string, number>()
  /** Liveness re-probe cadence. A wedged-but-not-crashed backend is caught within THRESHOLD ticks. */
  private static readonly LIVENESS_INTERVAL_MS = 5000
  /** Consecutive failures before a backend is declared unhealthy — the anti-flap / restart-window filter. */
  private static readonly LIVENESS_FAILURE_THRESHOLD = 2
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
  /**
   * Append stream for the UI child's RAW output tee. Deliberately NOT {@link appendLogFile}: that is an
   * `appendFileSync` (open/write/close syscall per call), fine for the renderer's occasional lines but a
   * blocking write once per chunk during an HMR burst — on the same event loop that repaints the pinned
   * footer. Opened in {@link startUiDev}, closed in {@link shutdown}.
   */
  private uiLogStream: fs.WriteStream | null = null
  /** `turbo --dry` closure-source seam — real turbo (via {@link buildClosureMap}'s default) unless injected for tests. */
  private readonly dryRunner: DryRunner | undefined
  /** Apps that threw during {@link startAllApps} — rendered as `● failed` rows by {@link printReady}. */
  private readonly failedApps: { app: IApiAppConfig; reason: string }[] = []
  /**
   * The terminal UI — owns every stdout line + the log-file tee. Either the plain {@link DevRenderer}
   * or the Ink boot UI, selected by {@link run} and injected here; the runner drives it through {@link DevUi}.
   */
  private readonly renderer: DevUi
  /** Health-probe seam (real bounded `/__health` GET by default; injectable for tests). */
  private readonly healthProbe: HealthProbe
  /** Portless driver (Layer B) — best-effort alias registration; injectable for tests. */
  private readonly proxy: PortlessDriver
  /**
   * The port the portless daemon must be serving TLS on. Fixed at {@link DEFAULT_DEV_PROXY_PORT} (443):
   * it is not configurable, because a port-free `https://` URL can only be served from the implicit HTTPS
   * port. A configurable port would put the port straight back into the URL.
   */
  private readonly proxyPort: number = DEFAULT_DEV_PROXY_PORT
  /** Every `<release>.<package>` alias this runner registered; removed one-by-one in {@link shutdown}. */
  private readonly registeredAliases = new Set<string>()
  /**
   * `{ "<ui-package>": { port, alias } }` handed to the turbo child via `INFRA_KIT_UI_PORTS` (computed in
   * printReady).
   *
   * The `alias` is load-bearing, not provenance: the page is served from `https://<alias>` on :443, so
   * vite's HMR client must dial `wss://<alias>` — left to itself it derives the socket from vite's own
   * bound port, which the browser then blocks as mixed content. Only the runner knows which alias it
   * actually registered, so it publishes it rather than letting the helper re-derive it (a helper that
   * merely *computes* an alias would point HMR at an unregistered host on a bare `vite dev`).
   */
  private uiPortMap: Record<string, { port: number; alias: string }> = {}
  /**
   * Latched by {@link shutdown} before it touches any state. Teardown deregisters aliases and then
   * spends seconds reaping children, so without this latch a watch event — or a restart already in
   * flight — re-enters {@link startOneApp} and re-registers an alias that nothing will ever remove.
   */
  private shuttingDown = false
  /**
   * Dependency closure used to scope a shared-package restart, or `null` for "restart every app"
   * (the fail-safe {@link selectPackageRestartTargets} already honours). Read at EVENT time, not
   * captured when the watcher is armed: building it shells out to turbo (~1s on a 7-backend repo),
   * and blocking the watcher on it left a window right after `ready` in which a save was silently
   * dropped. The watcher arms immediately on `null` and this is swapped in when turbo answers.
   */
  private closureMap: ClosureMap | null = null
  /** In-flight {@link closureMap} build, awaited by {@link shutdown} so no turbo child outlives the runner. */
  private closureBuild: Promise<void> = Promise.resolve()

  constructor(
    options: DevServerOptions = {},
    runBuild: BuildRunner = launchScript,
    turboWatchFactory: TurboWatchFactory = defaultTurboWatchFactory,
    uiDevFactory: UiDevFactory = defaultUiDevFactory,
    dryRunner?: DryRunner,
    renderer?: DevUi,
    healthProbe: HealthProbe = defaultHealthProbe,
    proxy: PortlessDriver = createPortlessDriver(),
  ) {
    this.options = options
    this.runBuild = runBuild
    this.turboWatchFactory = turboWatchFactory
    this.uiDevFactory = uiDevFactory
    this.dryRunner = dryRunner
    this.proxy = proxy
    initLogFile()
    // The renderer owns all terminal output + the log tee; construct it before the first narrate below.
    this.renderer = renderer ?? new DevRenderer({ appendLog: appendLogFile, verbose: this.options.verbose ?? false })
    this.healthProbe = healthProbe
    this.devContextDir = path.join(process.cwd(), '.infra-kit', 'dev-context')

    // Walk up from the consumer repo cwd to the monorepo root.
    this.monorepoRoot = findMonorepoRoot(process.cwd())

    if (process.env.DOPPLER_PROJECT != null || process.env.DOPPLER_ENVIRONMENT != null) {
      this.renderer.log('🔐 Doppler env detected (DOPPLER_PROJECT / DOPPLER_ENVIRONMENT)', 'debug')
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
        preferredPort: this.resolvePreferredPort(app.name, devConfig),
        prefixUrl: this.resolvePrefixUrl(app.name, devConfig),
        // Default participate; the resolved preset value overrides this in `run()`.
        watchDeps: true,
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

  /** Thin delegator to the pure {@link resolvePreferredPortPure}, threading env + config. */
  private resolvePreferredPort(appName: string, devConfig: DevConfig): number | undefined {
    return resolvePreferredPortPure(appName, process.env, devConfig)
  }

  /** Thin delegator to the pure {@link resolvePrefixUrlPure}. */
  private resolvePrefixUrl(appName: string, devConfig: DevConfig): string {
    return resolvePrefixUrlPure(appName, devConfig)
  }

  /** Load the top-level `devServersPresets` map from the resolved infra-kit config (defensive: `{}` on failure). */
  private async loadDevPresets(): Promise<DevPresets> {
    try {
      return (await getInfraKitConfig()).devServersPresets ?? {}
    } catch {
      return {}
    }
  }

  /**
   * The preset definition to run: the named preset (`infra-kit dev <preset>`; throws with the
   * available names when unknown), or an `apps`-less preset when no preset was given — which
   * `resolvePreset` expands to every discovered app + part.
   */
  private resolvePresetDef(devPresets: DevPresets): DevPreset {
    // A wizard-built in-memory preset wins over the named lookup: it already IS the resolved run plan.
    if (this.options.presetDef != null) {
      return this.options.presetDef
    }

    const name = this.options.preset

    if (name == null) {
      return {}
    }

    const def = devPresets[name]

    if (!def) {
      const available = Object.keys(devPresets)

      throw new Error(
        `Unknown dev preset "${name}". Available: ${available.length > 0 ? available.join(', ') : '(none defined in devServersPresets)'}`,
      )
    }

    return def
  }

  public async start(): Promise<void> {
    // Backend readiness clock (UI is fire-and-forget, so `ready in Xs` is BE-only — labeled honestly).
    const bootStart = Date.now()
    const include = this.normalizeAppInclude()
    const watch = this.options.watch ?? false
    const devConfig = await this.loadDevConfig()

    process.env.POWERTOOLS_DEV ??= 'true'
    process.env.LOG_LEVEL ??= 'DEBUG'

    this.renderer.narrate('🚀 Starting Development Server Runner')

    if (watch) {
      this.renderer.narrate('👀 Watch mode: will rebuild and restart on file save')
    }

    const { apps, uiApps, apiAppsAll, uiAppsAll } = await this.resolveRunPlan(devConfig, include)

    if (apps.length === 0 && uiApps.length === 0) {
      this.renderer.log('⚠️  No API or UI apps to run for this preset', 'warn')

      return
    }

    await this.bringUpProxy(apps)
    await this.buildAll(apps, uiApps, watch)

    if (apps.length > 0) {
      this.renderer.bootStep('starting servers')
      await this.startAllApps(apps)
      this.renderer.narrate(
        this.failedApps.length === 0
          ? '🎉 All servers started!'
          : `⚠️  ${this.appServers.length}/${apps.length} servers started — ${this.failedApps.length} failed`,
      )
      this.renderer.narrate(
        `📝 Handler logs (AWS Powertools, logger.info/debug, etc.) → this terminal. Runner-only file: ${LOG_FILE_PATH}`,
      )
    }

    // Collapse the boot spinner into the calm ready header (BE endpoints + UI reference lines).
    // Runs for a UI-only session too, so it never leaves a blank screen. The route dump is opt-in.
    // The header names the running packages, so it is derived from the post-`--app` sets — not from
    // `options.preset` (unset for the wizard's in-memory preset) nor from `include` (app names only).
    const target = deriveTargetLabel({
      preset: this.options.preset,
      running: [
        ...apps.map((a) => {
          return `${a.name}/api`
        }),
        ...uiApps.map((a) => {
          return `${a.name}/ui`
        }),
      ],
      discovered: [
        ...apiAppsAll.map((a) => {
          return `${a.name}/api`
        }),
        ...uiAppsAll.map((a) => {
          return `${a.name}/ui`
        }),
      ],
    })

    await this.printReady(apps, uiApps, bootStart, target)
    if (this.options.routes) {
      this.printRouteDump()
    }

    // Everything the user asked for is dead and there is no UI to fall back on: there is nothing left
    // to serve, watch, or proxy. Resident-but-empty is the worst of both worlds — it looks like a
    // running dev server and exits 0 when finally interrupted, so a CI step or a script would call it
    // a success. Fail loudly instead. A PARTIAL failure stays resident: the survivors are still useful,
    // and `--watch` can bring the casualties back on the next save.
    if (this.appServers.length === 0 && uiApps.length === 0 && this.failedApps.length > 0) {
      throw new Error(
        `infra-kit dev: no app started (${this.failedApps.length} of ${apps.length} failed). ` +
          `First failure: ${this.failedApps[0]?.reason ?? 'unknown'}`,
      )
    }

    this.armWatch(apps, uiApps, watch)

    // Frontends last: their delegated `turbo run dev` feeds the live tail below the BE table.
    if (uiApps.length > 0) {
      this.startUiDev(uiApps)
    }

    // Watch each running backend's health for the rest of the session. Armed only when a backend is
    // running — UI liveness is vite's, not ours. A UI-only session has nothing to probe.
    if (this.appServers.length > 0) {
      this.startLivenessMonitor()
    }
  }

  /**
   * Resolve WHAT to run: discover the api/ui app parts, resolve the active preset against them, then
   * narrow to the `--app`/`--self` include set. Returns both the filtered run sets (`apps`/`uiApps`)
   * and the full discovered sets (`apiAppsAll`/`uiAppsAll`), which the ready-header target label needs.
   */
  private async resolveRunPlan(
    devConfig: DevConfig,
    include: string[] | null,
  ): Promise<{
    apps: IApiAppConfig[]
    uiApps: DiscoveredUiApp[]
    apiAppsAll: IApiAppConfig[]
    uiAppsAll: DiscoveredUiApp[]
  }> {
    // What to run is a named preset (`infra-kit dev <preset>`), resolved against the discovered app
    // parts (api/ui). No preset → run everything (`*`). `--app`/`--self` (`include`) further narrow it.
    const apiAppsAll = this.discoverApiApps(devConfig)
    const uiAppsAll = discoverUiAppsBare(this.monorepoRoot)
    const resolved = resolvePreset(this.resolvePresetDef(await this.loadDevPresets()), {
      api: apiAppsAll.map((a) => {
        return a.name
      }),
      ui: uiAppsAll.map((a) => {
        return a.name
      }),
    })

    if (resolved.unmatched.length > 0) {
      this.renderer.log(`⚠️  Preset targets not found (skipped): ${resolved.unmatched.join(', ')}`, 'warn')
    }

    const apiNames = new Set(
      resolved.targets
        .filter((t) => {
          return t.part === 'api'
        })
        .map((t) => {
          return t.app
        }),
    )
    const uiNames = new Set(
      resolved.targets
        .filter((t) => {
          return t.part === 'ui'
        })
        .map((t) => {
          return t.app
        }),
    )
    const passesInclude = (name: string): boolean => {
      return !include || include.includes(name)
    }
    const watchDepsByApp = new Map(
      resolved.targets
        .filter((t) => {
          return t.part === 'api'
        })
        .map((t) => {
          return [t.app, t.watchDeps] as const
        }),
    )
    const apps = apiAppsAll
      .filter((a) => {
        return apiNames.has(a.name) && passesInclude(a.name)
      })
      .map((a) => {
        return { ...a, watchDeps: watchDepsByApp.get(a.name) ?? a.watchDeps }
      })
    const uiApps = uiAppsAll.filter((a) => {
      return uiNames.has(a.name) && passesInclude(a.name)
    })

    return { apps, uiApps, apiAppsAll, uiAppsAll }
  }

  /**
   * Layer B: confirm the portless proxy is serving BEFORE any alias registration — backends register in
   * startOneApp, UIs in printReady, and both need a live daemon. Runs ahead of startAllApps AND startUiDev
   * so a UI-only session checks it too; a proxy that is not up throws here, before anything is spawned.
   *
   * The port is no longer negotiable: every dev URL is `https://<alias>` with no port, which means the one
   * port that can serve them is {@link DEFAULT_DEV_PROXY_PORT} (443, the implicit HTTPS port).
   */
  private async bringUpProxy(apps: IApiAppConfig[]): Promise<void> {
    // Before anything is spawned or aliased: refuse if the consumer's PINNED `infra-kit/vite` predates the
    // HTTPS contract. It would ignore the fragment's `origin` and proxy plain HTTP at a TLS listener.
    assertHelperVersionFloor(findMonorepoRoot(process.cwd()))
    await this.ensureProxy()

    if (apps.length > 0) this.assertNoPortConflicts(apps)
  }

  /**
   * Build both build phases back to back under one boot line: the API boot closure (dist must exist
   * before servers import handlers) then the UI dependency closure (warmed BEFORE any persistent child
   * so both see a warm cache and the cold-cache double-build race can't corrupt shared dist).
   */
  private async buildAll(apps: IApiAppConfig[], uiApps: DiscoveredUiApp[], watch: boolean): Promise<void> {
    // One boot line covers both build phases: they run back to back, so two boot steps only make
    // the spinner flip between near-identical lines. Never empty — the no-apps case returned above.
    const bootLabel = [
      apps.length > 0 ? `building ${packageList(apps)}` : '',
      uiApps.length > 0 ? `warming ${packageList(uiApps)}` : '',
    ]
      .filter(Boolean)
      .join(' · ')

    this.renderer.bootStep(bootLabel)

    if (apps.length > 0) await this.buildApps(apps, watch)
    if (uiApps.length > 0) await this.buildUiApps(uiApps)
  }

  /**
   * Start the watch engine when there's anything to rebuild — backends OR frontends. A UI-only session
   * (no API app) still needs the engine so a shared-lib edit rebuilds its dist and vite reloads.
   */
  private armWatch(apps: IApiAppConfig[], uiApps: DiscoveredUiApp[], watch: boolean): void {
    if (!(watch && (this.appServers.length > 0 || uiApps.length > 0))) {
      return
    }

    // Arm the watcher FIRST, on the fail-safe `null` map (a shared-package change restarts every app).
    // Awaiting the closure map here instead cost ~1s on a 7-backend repo — a full second after "ready"
    // in which a save was watched by nobody. Scoping is an optimisation; never buy it with a blind window.
    this.setupWatch(apps, uiApps)

    this.closureBuild = this.buildClosureMapSafe(apps).then((map) => {
      // A teardown may have overtaken us; assigning is harmless either way (nothing reads it after).
      this.closureMap = map
    })
  }

  /**
   * Warm ONLY each UI's dependency closure (`<pkg>^...` — deps, excluding the UI itself, so no full
   * production `vite build`) with a cache-friendly (non-`--force`) turbo build.
   *
   * This is the ONLY build of that closure: the `turbo run dev` child runs with `--only`, so it no
   * longer re-walks `^build` as a fallback (that walk was pure noise — see {@link file://./ui-dev.ts}).
   * Still non-fatal, because a failure here is loud rather than silent: vite fails to resolve the
   * missing dep and reports it in the live tail. Warn and continue instead of refusing to start.
   */
  private async buildUiApps(uiApps: DiscoveredUiApp[]): Promise<void> {
    const filters = uiApps
      .map((a) => {
        return `--filter=${a.packageName}^...`
      })
      .join(' ')

    try {
      await this.runBuild(
        `pnpm exec turbo run build ${filters} --env-mode=loose --output-logs=errors-only --no-update-notifier`,
        this.renderer.logFn,
      )
      this.renderer.narrate('✅ UI deps built')
    } catch (error) {
      this.renderer.log(
        `⚠️  UI dep build failed (continuing; vite will report unresolved deps): ${String(error)}`,
        'warn',
      )
    }
  }

  /**
   * Start the frontends via ONE delegated `turbo run dev` child. Its stdio is PIPED, so the raw output
   * is tee'd verbatim to the runner log while each framework line lands in the renderer's tagged tail —
   * the terminal stays owned by `infra-kit dev`. Reaped on {@link shutdown}. Concurrency ≥ the persistent
   * UI `dev` task count (turbo hard-errors otherwise).
   */
  private startUiDev(uiApps: DiscoveredUiApp[]): void {
    const names = uiApps
      .map((a) => {
        return a.name
      })
      .join(', ')

    this.renderer.narrate(`🎨 Starting ${uiApps.length} UI dev server(s) via \`turbo run dev\`: ${names}`)
    this.renderer.narrate('   (framework output is routed into the live tail; full detail in the runner log)')

    // Hand the runner-assigned UI ports to the vite child so each UI binds exactly the port the ready
    // header already advertised (`strictPort` on the vite side) — proxy or not, the printed URL and the
    // bound port cannot drift. An empty map (every assignment failed) passes no env, so vite falls back
    // to picking its own free port and printing it.
    const uiPortEnv =
      Object.keys(this.uiPortMap).length > 0 ? { INFRA_KIT_UI_PORTS: JSON.stringify(this.uiPortMap) } : undefined

    // Every dev URL is now HTTPS behind portless's PRIVATE CA, which Node's bundled trust store knows
    // nothing about (and Node does not read the macOS keychain, so `portless trust` alone does not help a
    // Node process). Vite's own proxy is covered by the scoped `secure: false`, but anything ELSE the dev
    // loop runs — a backend calling a sibling's hero URL, a node `fetch`, an e2e runner — would fail with
    // `SELF_SIGNED_CERT_IN_CHAIN`. Hand the CA down so those clients validate instead of breaking.
    // A pre-set NODE_EXTRA_CA_CERTS wins: it is the user's own trust decision, not ours to overwrite.
    const caEnv =
      process.env.NODE_EXTRA_CA_CERTS == null && fs.existsSync(readCaPath())
        ? { NODE_EXTRA_CA_CERTS: readCaPath() }
        : undefined

    // turbo tags each line with the PACKAGE name; the endpoint rows are keyed by APP name (`client/ui`),
    // so map back onto the exact label the ready header already shows. An unrecognized package degrades
    // to its own name rather than being dropped — a line is never silently lost.
    const tagByPackage = new Map(
      uiApps.map((a) => {
        return [a.packageName, `${a.name}/ui`] as const
      }),
    )

    // Non-fatal on a log-write failure: a broken tee must never down the dev session, and the terminal
    // tail still carries every framework line.
    this.uiLogStream = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a' })
    this.uiLogStream.on('error', () => {
      this.uiLogStream = null
    })

    this.uiDev = this.uiDevFactory({
      packageNames: uiApps.map((a) => {
        return a.packageName
      }),
      cwd: process.cwd(),
      concurrency: Math.max(uiApps.length + 4, 12),
      env: uiPortEnv || caEnv ? { ...uiPortEnv, ...caEnv } : undefined,
      appendLog: (text) => {
        this.uiLogStream?.write(text)
      },
      onLine: ({ pkg, text }) => {
        this.renderer.event({ tag: tagByPackage.get(pkg) ?? `${pkg}/ui`, text })
      },
      // Surface a silently-dead frontend engine: once `turbo run dev` exits, every UI's live reload
      // stops and no framework line ever reaches the tail again.
      onUnexpectedExit: (detail) => {
        this.reportEngineDeath('UI dev engine (`turbo run dev`)', 'frontends stopped reloading', detail)
      },
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

  /**
   * Throw (after logging remediation tips) when two apps are EXPLICITLY pinned to the same
   * port. Apps with no explicit port bind an ephemeral `listen(0)` port each (collision-free
   * by construction), so they are excluded from the gate — otherwise the default multi-app
   * run would false-throw on the shared `DEFAULT_PORT` before dynamic allocation de-conflicts.
   */
  private assertNoPortConflicts(apps: IApiAppConfig[]): void {
    const explicitApps = apps
      .filter((app) => {
        return app.preferredPort != null
      })
      .map((app) => {
        return { name: app.name, port: app.preferredPort! }
      })
    const { duplicatePorts, conflictingApps } = findPortConflicts(explicitApps)

    if (duplicatePorts.length === 0) {
      return
    }

    this.renderer.log(`⚠️  Port conflict detected! ${duplicatePorts.join(', ')}`, 'error')
    this.renderer.log(`Conflicting apps: ${this.formatAppList(conflictingApps)}`, 'error')
    this.renderer.log('\n💡 Tip: give each app a distinct port via `{APP}_PORT` env (e.g. `CLIENT_PORT=`,', 'error')
    this.renderer.log('   `SEARCH_ENGINE_PORT=`) or `dev.<app>.port` in infra-kit.json; or run a subset with', 'error')
    this.renderer.log('   `--app=<name>,<name>`.\n', 'error')
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
    const buildCmd = `pnpm exec turbo run build ${filters} --env-mode=loose --output-logs=errors-only --no-update-notifier${watch ? ' --force' : ''}`

    // No narration here: the `building <pkgs>` boot step already names these exact targets.
    try {
      await this.runBuild(buildCmd, this.renderer.logFn)
      this.renderer.narrate('✅ Build complete')
    } catch (buildError) {
      this.renderer.log(`❌ Build failed: ${String(buildError)}`, 'error')
      if (buildError instanceof Error && buildError.message) {
        this.renderer.log(`   ${buildError.message}`, 'error')
      }
      const err = buildError as { stdout?: string; stderr?: string }

      if (err.stdout) this.renderer.log(`   stdout: ${err.stdout.trim()}`, 'error')
      if (err.stderr) this.renderer.log(`   stderr: ${err.stderr.trim()}`, 'error')
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
          const started = await this.startOneApp(app)

          if (started) {
            this.appServers.push({ app, ...started })
          }
        } catch (error) {
          this.renderer.log(`❌ Failed to start ${app.name}: ${String(error)}`, 'error')
          // Recorded, not just logged: `printReady` renders the table from `appServers`, so an app
          // that only ever appears in a log line vanishes from the header entirely — indistinguishable
          // from one that was never requested. `failedApps` is what puts the `● failed` row back.
          this.failedApps.push({ app, reason: errorReason(error) })
        }
      }),
    )
  }

  /**
   * Confirm a portless daemon is serving TLS on {@link DEFAULT_DEV_PROXY_PORT} before any alias is
   * registered. Every dev URL is a hostname served by this daemon, so a proxy that is not up is a FATAL
   * start error, not a degraded mode: there is no second way to reach an app, and a half-started dev loop
   * that silently routes nowhere is worse than a refusal that names the fix.
   *
   * **Probe only — never start, never elevate.** `:443` is privileged, and portless binds it by re-execing
   * through `sudo` with an inherited stdio, which a detached child cannot answer. The daemon is installed
   * once, out-of-band. There is deliberately no unprivileged fallback: a fallback puts the port back in the
   * URL, which is the whole thing this design removes.
   *
   * Identity is proven **on the wire** (`X-Portless`), never from portless's state files — those are
   * process-global singletons that any other daemon's start rewrites and any stop deletes, which would make
   * a perfectly healthy `:443` daemon look dead. See {@link defaultIsProxyServing}.
   *
   * @throws When portless is missing, or no portless daemon is serving TLS on the proxy port.
   */
  private async ensureProxy(): Promise<void> {
    // The bin comes from the driver we were handed, never from a fresh resolution behind its back: the fix we
    // print must name the binary THIS driver would run. `null` is not a command to render — it is a different
    // report, and it is made here rather than passed downstream.
    const bin = this.proxy.binPath()

    if (bin == null || !(await this.proxy.isAvailable())) {
      throw new Error(
        'infra-kit dev: portless is not installed, so no dev URL can resolve. It ships as a dependency of infra-kit — reinstall with `pnpm install`.',
      )
    }

    if (await this.proxy.isProxyServing(this.proxyPort, true)) return

    throw new Error(
      `infra-kit dev: no portless daemon is serving HTTPS on :${this.proxyPort}, so no dev URL can resolve. ` +
        'Install it once (this is the only step that needs root):\n' +
        `    ${formatPortlessCommand(['service', 'install'], { sudo: true, bin })}\n` +
        'Then trust its local CA (no sudo needed):\n' +
        `    ${formatPortlessCommand(['trust'], { bin })}\n` +
        '`infra-kit doctor` checks both.',
    )
  }

  /**
   * Register `<release>.<package>` → `port` with portless and return the alias HOST
   * (`<release>.<package>.localhost`). The alias IS the app's only address, so a failure here is fatal
   * rather than a silent downgrade — an app nobody can reach is not a running app.
   *
   * @throws When the package name yields no legal DNS label, or portless rejects the registration.
   */
  private async registerAppAlias(packageName: string, appDir: string, port: number): Promise<string> {
    const release = readAppRelease(appDir)
    // An npm name is not a DNS label — see {@link slugifyHostLabel}. `infra-kit/vite` slugifies its
    // own `<packageName>` template token identically, so the proxy target and this alias cannot drift.
    const label = slugifyHostLabel(packageName)

    if (label === '') {
      throw new Error(`infra-kit dev: package name "${packageName}" has no letters or digits to build a hostname from.`)
    }
    const name = `${release}.${label}`

    if (!(await this.proxy.registerAlias(name, port))) {
      throw new Error(`infra-kit dev: portless refused the alias "${name}" → 127.0.0.1:${port}.`)
    }
    this.registeredAliases.add(name)

    return `${name}.localhost`
  }

  private async startOneApp(
    app: IApiAppConfig,
  ): Promise<{ server: ServerlessLocalRun; boundPort: number; alias: string } | null> {
    this.renderer.narrate(`🔄 Starting ${app.name}...`)

    // No `process.chdir` here: `ServerlessLocalRun` reads `serverless.yml` and imports the
    // compiled handler from `controllersPath` (absolute), so the runner never mutates cwd —
    // which is what makes concurrent boot/restart safe.
    const server = new ServerlessLocalRun({
      controllersPath: app.path,
      prefixUrl: app.prefixUrl,
      port: app.preferredPort,
      appName: app.name,
      // Route live request traffic into the renderer's tagged, timestamped tail (`<app>/api …`).
      // This is the structured seam — independent of the legacy `DEV_SERVER_REQUEST_LOG` raw line —
      // so the app name is threaded in-process and never leaked to spawned turbo/vite children.
      onRequestLog: ({ method, path: reqPath, status, ms }) => {
        // Keep the runner's own `/__health` liveness probes out of the live tail — they are internal
        // noise, not app traffic. Real handler routes still stream.
        if (reqPath === '/__health') return
        this.renderer.event({ tag: `${app.name}/api`, text: `${method} ${reqPath} ${status} ${ms}ms` })
      },
    })

    // `start()` binds an ephemeral (or preferred-then-ephemeral) port and RETURNS the actual
    // one — consume THAT, never the static preferred hint, so the log/table/health agree.
    const boundPort = await server.start()

    // Layer B: (re)point the portless alias to the freshly-bound port (also fires on watch-restart,
    // since startOneApp is the shared start+restart path). Throws if the alias cannot be registered.
    //
    // Unwind the bind on failure: the caller only records `server` in `appServers` once this method
    // RETURNS, so a throw here would otherwise leave a listening fastify that `shutdown()` never sees
    // and never closes — a port held for the rest of the session.
    let alias: string

    try {
      alias = await this.registerAppAlias(app.packageName, app.path, boundPort)
    } catch (error) {
      await server.close().catch(() => {})
      throw error
    }

    // Record the ACTUAL bound port + the alias that was actually registered in this runner's own
    // dev-context fragment. Ordered AFTER registerAppAlias: a fragment written before it could only
    // ever claim `alias: undefined`, and the vite helper would fall back to a direct target for an
    // app that IS reachable by name. Inside startOneApp (the shared start+restart path) so a
    // watch-restart refreshes both instead of orphaning a stale fragment (M2). Non-fatal: a
    // fragment-write failure must not down the server.
    try {
      this.writeDevContextFragment(app, boundPort, alias)
    } catch (error) {
      this.renderer.log(`⚠️  Failed to write dev-context fragment for ${app.name}: ${String(error)}`, 'warn')
    }

    this.renderer.narrate(`✅ ${app.name} started on port ${boundPort}`)

    return { server, boundPort, alias }
  }

  /**
   * Atomically write this runner's `.infra-kit/dev-context/<app>.json` fragment recording the
   * ACTUAL bound port (REV-5: serialize to a same-dir temp file, then `renameSync` into place, so a
   * concurrent reader — the vite helper's directory merge — never observes torn JSON). Each runner
   * writes ONLY its own app's fragment, so cmux panes never clobber each other.
   */
  private writeDevContextFragment(app: IApiAppConfig, boundPort: number, alias: string): void {
    const fragment: DevContextFragment = {
      package: app.packageName,
      port: boundPort,
      pid: process.pid,
      writtenAt: Date.now(),
      release: readAppRelease(app.path),
      alias,
      // The ORIGIN of the hero URL the ready screen prints (`resolveEndpointUrl` appends the app's
      // `prefixUrl` on top of this same alias). Prefix-free on purpose: this is a proxy target, and the
      // frontend supplies its own path.
      origin: `https://${alias}`,
    }
    const target = path.join(this.devContextDir, `${app.name}.json`)
    const tmp = path.join(this.devContextDir, `${app.name}.json.${process.pid}.tmp`)

    fs.mkdirSync(this.devContextDir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(fragment, null, 2))
    fs.renameSync(tmp, target)
  }

  /** Remove THIS runner's own `<app>.json` fragment on shutdown (never another runner's). */
  private removeDevContextFragment(app: IApiAppConfig): void {
    fs.rmSync(path.join(this.devContextDir, `${app.name}.json`), { force: true })
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
    if (this.shuttingDown) return Promise.resolve()

    return this.scheduleRestartWork(() => {
      // Re-checked inside the chain: this job may have queued behind a restart that was still
      // running when shutdown() latched, so the flag can flip between scheduling and execution.
      if (this.shuttingDown) return Promise.resolve()

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

    this.renderer.log(`🔄 Restarting ${label}...`)
    await Promise.all(
      targets.map(async ({ idx }) => {
        try {
          await this.appServers[idx]!.server.close()
        } catch (err) {
          this.renderer.log(`   Close warning: ${String(err)}`, 'debug')
        }
      }),
    )

    await this.delayPortRelease()

    // Thread each restart's OUTCOME (the fresh entry, or `null` on failure) straight into the probe below
    // instead of re-reading `appServers[idx]`: a failed `startOneApp` leaves the stale, now-closed entry in
    // that slot, so re-reading it would probe a freed port — wasting the full probe timeout and, if the old
    // `close()` also failed, reporting the dead-but-still-listening server as `● up`. The outcome list makes
    // the no-probe "down" branch actually reachable on failure.
    const outcomes = await Promise.all(
      targets.map(async ({ idx, app }) => {
        try {
          const restarted = await this.startOneApp(app)

          if (restarted) {
            const entry = { app, ...restarted }

            this.appServers[idx] = entry

            return { app, entry }
          }

          return { app, entry: null }
        } catch (error) {
          this.renderer.log(`❌ Failed to restart ${app.name}: ${String(error)}`, 'error')

          return { app, entry: null }
        }
      }),
    )
    // Show each restarted app's CURRENT bound port: an ephemeral-port app rebinds a fresh port on
    // restart, and the server table is printed only once at boot — so this line is the only place the
    // new port surfaces in the default (quiet) terminal.
    //
    // Re-probe `/__health` so the summary reports HONEST liveness, not a bare "restarted" for a server
    // that binds its port but 500s on the first request. Mirrors printReady's probe (127.0.0.1, never
    // `localhost` — ServerlessLocalRun binds v4 loopback only). Probes run concurrently; a target whose
    // restart failed (`entry === null`) is reported down without a probe. A single down server downgrades
    // the leading ✅ to ⚠️ so the line reads consistently.
    const probed = await Promise.all(
      outcomes.map(async ({ app, entry }) => {
        const healthy = entry ? await this.healthProbe(DevServerRunner.healthUrl(entry.boundPort)) : false
        const label = entry ? `${app.name}:${entry.boundPort}` : app.name

        return { label: `${label} ${healthy ? '● up' : '● down'}`, healthy }
      }),
    )

    const allHealthy = probed.every((p) => {
      return p.healthy
    })

    this.renderer.log(
      `${allHealthy ? '✅' : '⚠️ '} Restarted ${probed
        .map((p) => {
          return p.label
        })
        .join(', ')}`,
    )
  }

  /**
   * Build the dependency-closure map ({@link buildClosureMap}) for scoped restarts, or `null` on
   * failure (a `turbo --dry` spawn/parse error). `null` is the fail-safe signal: {@link setupWatch}
   * then restarts every launched app on a package change, exactly as it did before scoping — never
   * a silent dropped restart.
   */
  private async buildClosureMapSafe(apps: IApiAppConfig[]): Promise<ClosureMap | null> {
    try {
      return await buildClosureMap(this.monorepoRoot, apps, this.dryRunner)
    } catch (err) {
      this.renderer.log(
        `⚠️  Dependency-closure map unavailable (${String(err)}); package changes restart all apps`,
        'warn',
      )

      return null
    }
  }

  /**
   * Start the long-lived `turbo watch build` engine, then watch compiled `dist/` output to
   * trigger restarts. A change under an app's `dist` restarts that app; a change under a
   * `packages/<pkg>/dist` restarts only the participating backends whose dependency closure
   * includes that package ({@link selectPackageRestartTargets}), keyed per package dir so unrelated
   * packages don't collapse into one debounce bucket. When the closure map is unavailable
   * (`null`) it falls back to restarting every launched app (fail-safe superset). Restarts are
   * build-less — the engine already rebuilt `dist/`.
   */
  /**
   * Report a persistent engine (`turbo watch build` / `turbo run dev`) that died on its OWN as a single
   * warn line, unless teardown is already underway. Centralises the `shuttingDown` guard and the message
   * shape shared by both engine callbacks — `superviseChild`'s `killing` latch already suppresses the
   * exit our own `kill()` causes, so this only ever fires on a genuine crash.
   */
  private reportEngineDeath(engine: string, consequence: string, detail: string): void {
    if (this.shuttingDown) return
    this.renderer.log(`⚠️  ${engine} ${detail} — ${consequence}. Restart \`infra-kit dev\`.`, 'warn')
  }

  private setupWatch(apps: IApiAppConfig[], uiApps: DiscoveredUiApp[]): void {
    this.turboWatch = this.turboWatchFactory({
      // API apps: dep-inclusive (`...<pkg>`) — rebuild the backend + its shared-lib closure and restart it.
      depInclusive: apps.map((a) => {
        return a.packageName
      }),
      // UI apps: dep-closure-only (`<pkg>^...`) — rebuild the frontend's shared libs (so vite reloads on a
      // FE-only lib edit) WITHOUT production-building the UI; vite owns the UI's own live reload.
      depClosure: uiApps.map((a) => {
        return a.packageName
      }),
      cwd: process.cwd(),
      logFile: LOG_FILE_PATH,
      // Surface a silently-dead engine: once `turbo watch build` exits, saves no longer rebuild `dist/`,
      // so no restart ever fires and the session looks healthy while being frozen.
      onUnexpectedExit: (detail) => {
        this.reportEngineDeath('Watch engine (`turbo watch build`)', 'file saves no longer rebuild', detail)
      },
    })
    this.renderer.narrate('👀 Watch mode: started `turbo watch build` engine; watching dist output')

    const appDistDirs = getAppDistDirs(apps)
    const packageDistDirs = getPackageDistDirs(this.monorepoRoot)
    const allDistDirs = [...appDistDirs, ...packageDistDirs]

    if (allDistDirs.length === 0) {
      this.renderer.log('⚠️  No app or package dist directories found to watch (were they built?)', 'warn')

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
      this.renderer.log('👀 chokidar: usePolling enabled (DEV_SERVER_CHOKIDAR_POLL=1)', 'debug')
    }

    watcher.on('change', (filePath: string) => {
      this.handleDistChange(filePath, apps, appDistDirs, packageDistDirs)
    })

    this.renderer.narrate(
      `👀 Watching ${appDistDirs.length} app dist + ${packageDistDirs.length} package dist dir(s) for changes...`,
    )
  }

  /**
   * Dispatch a single dist-file change to the right restart. A package (shared-lib) change restarts the
   * dependent apps selected from the closure map (or, fail-safe, every app when the map is missing); an
   * app's own dist change restarts just that app. All restarts are debounced.
   */
  private handleDistChange(
    filePath: string,
    apps: IApiAppConfig[],
    appDistDirs: string[],
    packageDistDirs: string[],
  ): void {
    this.renderer.log(`👀 dist change detected: ${filePath}`, 'debug')

    const change = classifyDistChange(filePath, appDistDirs, packageDistDirs)

    if (change.kind === 'package') {
      // Read late: the map may still be building (→ `null` → restart all), which is correct, just unscoped.
      const targets = selectPackageRestartTargets(apps, this.closureMap, change.packageDir)

      if (targets === null) {
        // Fail-safe: no closure map / no package identity → restart every launched app. Note this
        // ignores per-app `watchDeps: false` opt-outs — opt-out is best-effort and yields to the
        // fail-safe superset, so a `turbo --dry` failure never silently drops a needed restart.
        this.scheduleDebounced('__packages__', () => {
          return this.restart(apps)
        })

        return
      }

      // Empty target set = the package is UI-only or every dependent opted out → no restart.
      // The `packageDir !== undefined` check narrows it to `string` for `packageDebounceKey`;
      // it is always defined here (a non-null `targets` implies a matched package identity).
      if (targets.length > 0 && change.packageDir !== undefined) {
        this.scheduleDebounced(packageDebounceKey(change.packageDir), () => {
          return this.restart(targets)
        })
      }

      return
    }

    const app = apps.find((a) => {
      return path.join(a.path, 'dist') === change.app
    })

    if (!app) return

    this.scheduleDebounced(app.name, () => {
      return this.restart([app])
    })
  }

  /**
   * Debounce a restart under `key`: cancel any pending timer for the same key and start
   * a fresh {@link DevServerRunner.WATCH_DEBOUNCE_MS} timer, so a burst of saves collapses
   * into one restart. Errors from the scheduled work are logged, never thrown.
   */
  private scheduleDebounced(key: string, work: () => Promise<void>): void {
    if (this.shuttingDown) return

    const existing = this.watchDebounceTimers.get(key)

    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.watchDebounceTimers.delete(key)
      if (this.shuttingDown) return
      work().catch((err) => {
        this.renderer.log(`Restart error (${key}): ${String(err)}`, 'error')
      })
    }, DevServerRunner.WATCH_DEBOUNCE_MS)

    this.watchDebounceTimers.set(key, timer)
  }

  /**
   * The `/__health` probe URL for a backend on `port`. Always `127.0.0.1`, never `localhost`:
   * ServerlessLocalRun binds v4 loopback only, while `localhost` resolves `[::1]` first on modern Node —
   * the same trap `infra-kit/vite` pins its own host around. Probing by name renders a healthy backend as
   * `● down`. One home for the string shared by boot ({@link printReady}), restart ({@link runRestart}),
   * and the liveness monitor ({@link livenessTick}).
   */
  private static healthUrl(port: number): string {
    return `http://127.0.0.1:${port}/__health`
  }

  /**
   * Start the always-on backend liveness monitor: a background probe loop that catches a backend which
   * goes unhealthy WITHOUT crashing the process (a blocked event loop, a wedged dependency, a fastify that
   * stopped serving) — invisible to both the one-shot {@link printReady} probe and the crash barrier, which
   * only sees thrown faults. Edge-triggered and flap-resistant; see {@link livenessTick}.
   */
  private startLivenessMonitor(): void {
    this.scheduleLivenessTick()
  }

  /**
   * Schedule the next liveness tick. A self-rescheduling `setTimeout` (never `setInterval`): a slow tick —
   * every backend timing out its probe — can never pile up on the next one, and teardown clears exactly one
   * timer. `unref()` so the monitor never keeps the process alive on its own; the fastify servers do that,
   * and lifecycle is owned by {@link shutdown}.
   */
  private scheduleLivenessTick(): void {
    const intervalMs = this.options.livenessIntervalMs ?? DevServerRunner.LIVENESS_INTERVAL_MS

    this.livenessTimer = setTimeout(() => {
      // `finally` always reschedules; the trailing `catch` swallows a rejecting probe seam so one bad tick
      // is skipped rather than crashing the loop, and leaves no floating promise.
      this.livenessTick()
        .finally(() => {
          if (!this.shuttingDown) this.scheduleLivenessTick()
        })
        .catch(() => {})
    }, intervalMs)
    this.livenessTimer.unref()
  }

  /**
   * One liveness sweep over every running backend. Edge-triggered per app, keyed by app NAME (so the
   * counter survives an ephemeral-port rebind on restart) with the CURRENT boundPort read fresh each tick:
   *
   * - a probe FAILURE increments a per-app counter; crossing {@link LIVENESS_FAILURE_THRESHOLD} consecutive
   *   failures logs ONE `⚠️ unhealthy` line. The threshold is what makes a normal watch-restart (server down
   *   <1s, a single interval) invisible — only a genuinely wedged backend stays down across two sweeps.
   * - a probe SUCCESS after the app had crossed the threshold logs ONE `✅ recovered` line; the counter
   *   always resets on success. Both edges fire once, so a steady state (healthy OR wedged) emits nothing.
   *
   * `/__health` probes are already filtered out of the live request tail ({@link startOneApp}'s
   * `onRequestLog`), so this never spams. Bails once teardown has latched so a closing server is not
   * misread as down (the timer is also cleared in {@link shutdown} before the servers close).
   */
  private async livenessTick(): Promise<void> {
    if (this.shuttingDown) return

    await Promise.all(
      this.appServers.map(async ({ app, boundPort }) => {
        const ok = await this.healthProbe(DevServerRunner.healthUrl(boundPort))

        // Re-check AFTER the await: shutdown() may have latched and begun closing servers while this probe
        // was in flight, resolving it `false` against a closing socket. Without this a tick that passed the
        // top-of-method bail could log a false `unhealthy` during teardown.
        if (this.shuttingDown) return

        const fails = this.livenessFailures.get(app.name) ?? 0

        if (ok) {
          if (fails >= DevServerRunner.LIVENESS_FAILURE_THRESHOLD) {
            this.renderer.log(`✅ ${app.name}/api recovered`)
          }
          this.livenessFailures.set(app.name, 0)

          return
        }

        const next = fails + 1

        this.livenessFailures.set(app.name, next)
        if (next === DevServerRunner.LIVENESS_FAILURE_THRESHOLD) {
          this.renderer.log(`⚠️  ${app.name}/api unhealthy (/__health not responding)`, 'warn')
        }
      }),
    )
  }

  /**
   * Collapse the boot spinner into the calm ready header: one endpoint row per running backend
   * (pre-probed health dot + a resolving URL), one reference line per UI app (vite prints its own
   * URL in the stream below), the watch line, the clickable log path, and a separator rule.
   * Handles a UI-only session (no backend rows) so it never leaves a blank screen. `ready()` itself
   * is synchronous — health is probed here and passed in resolved.
   */
  private async printReady(
    apps: IApiAppConfig[],
    uiApps: DiscoveredUiApp[],
    bootStart: number,
    target: string,
  ): Promise<void> {
    // Snapshot BE readiness BEFORE probing — a `● down` server's probe timeout must not inflate
    // `ready in Xs` (nor is the boot time itself the probe latency).
    const elapsedMs = Date.now() - bootStart
    const health = await Promise.all(
      this.appServers.map(({ boundPort }) => {
        return this.healthProbe(DevServerRunner.healthUrl(boundPort))
      }),
    )
    const endpoints: EndpointRow[] = this.appServers.map(({ app, alias }, i) => {
      return {
        tag: `${app.name}/api`,
        url: resolveEndpointUrl({ prefixUrl: app.prefixUrl, alias }),
        healthy: health[i] ?? null,
      }
    })

    // Pre-assign each UI a free port + its portless alias and stash the map for startUiDev's env. Owning
    // the port is what makes the UI's URL knowable before vite prints it, so every UI gets a real endpoint
    // row. No health probe: vite owns its own readiness. Only a UI whose port could not be assigned falls
    // back to a reference line ("vite prints its URL below").
    this.uiPortMap = {}
    const uiEndpoints: EndpointRow[] = []
    const uiRefs: UiRef[] = []

    for (const ui of uiApps) {
      const assigned = await this.assignUiPort(ui)

      if (assigned != null) {
        uiEndpoints.push({
          tag: `${ui.name}/ui`,
          url: resolveEndpointUrl({ prefixUrl: '', alias: assigned.alias }),
          healthy: null,
        })
      } else {
        uiRefs.push({ tag: `${ui.name}/ui` })
      }
    }
    const watch = this.options.watch ?? false
    const appCount = apps.length + uiApps.length
    const pkgCount = getPackageDistDirs(this.monorepoRoot).length

    this.renderer.ready({
      target,
      watch,
      // A UI child (`turbo run dev`) launches iff any UI app runs. This is the sticky-footer signal:
      // its piped output feeds a busy live tail, which the scroll-region UI pins the header above.
      // (`uiRefs` can't serve as the signal — it empties once a UI aliases into an endpoint row, Layer B.)
      hasUiChild: uiApps.length > 0,
      release: readAppRelease(process.cwd()),
      elapsedMs,
      endpoints: [...endpoints, ...uiEndpoints],
      uiRefs,
      failed: this.failedApps.map(({ app, reason }) => {
        return { tag: `${app.name}/api`, reason }
      }),
      watchSummary: `${appCount} app${appCount === 1 ? '' : 's'} · ${pkgCount} package${pkgCount === 1 ? '' : 's'}`,
      logPath: homeShorten(LOG_FILE_PATH),
      logHref: LOG_FILE_PATH,
    })
  }

  /**
   * Pre-assign a UI a free port, alias it, and record the port in {@link uiPortMap} (handed to the vite
   * child via `INFRA_KIT_UI_PORTS`, which it binds with `strictPort`). Owning the port ahead of vite's own
   * announcement is what makes the URL knowable in time to print it.
   *
   * `null` degrades this UI to a reference line: either its vite config does not wire `infraKitDev()`
   * ({@link DiscoveredUiApp.managedPort}), so it would ignore the assignment and bind its own port —
   * printing the assigned one would be a lie and aliasing it would 502 — or the free-port probe failed
   * (extremely rare). An alias that portless REFUSES is not degraded here: {@link registerAppAlias} throws,
   * because a UI advertised at a hostname nothing serves is worse than a UI with no row.
   */
  private async assignUiPort(ui: DiscoveredUiApp): Promise<{ port: number; alias: string } | null> {
    if (!ui.managedPort) return null

    let port: number

    try {
      port = await getFreePort()
    } catch {
      return null
    }
    const alias = await this.registerAppAlias(ui.packageName, ui.path, port)

    this.uiPortMap[ui.packageName] = { port, alias }

    return { port, alias }
  }

  /**
   * Dump each running app's registered `METHOD /path` routes (opt-in via `--routes`) so the
   * emulator is self-describing. Prints to the terminal (not verbose-gated) — invoking it means
   * the user explicitly asked for the routes. Reads the live set via `getRegisteredRoutes`.
   */
  private printRouteDump(): void {
    if (this.appServers.length === 0) return

    this.renderer.log('🗺️  Registered routes:')
    for (const { app, server } of this.appServers) {
      const routes = server.getRegisteredRoutes()

      this.renderer.log(`   ${app.name} (${routes.length}): ${routes.length > 0 ? routes.join(', ') : '(none)'}`)
    }
  }

  /**
   * Stop watching, cancel any pending debounced restart, and close all running servers.
   * Does not exit the process — the entry point owns exit.
   */
  public async shutdown(): Promise<void> {
    // Latch BEFORE anything else. Everything below assumes no new alias can be registered once
    // teardown begins; `scheduleDebounced` and `restart` read this flag to honour that.
    this.shuttingDown = true

    // Release the terminal FIRST: if the Ink boot UI is still mounted (e.g. SIGINT mid-boot), unmount it
    // before any plain write below, so the shutdown lines never clobber a live region. No-op for the
    // plain renderer and idempotent when Ink already unmounted at ready().
    this.renderer.dispose()
    this.renderer.log('🛑 Shutting down all servers...')

    // Silence every restart SOURCE before deregistering aliases below. Ordered first because alias
    // removal is not idempotent against a concurrent `startOneApp`: a chokidar event or an armed
    // debounce timer firing after the removal would re-register an alias into a set nothing drains
    // again, stranding it exactly like the force-quit case the removal is there to prevent.
    for (const timer of this.watchDebounceTimers.values()) {
      clearTimeout(timer)
    }
    this.watchDebounceTimers.clear()

    // Stop the liveness monitor BEFORE the servers close, so a final tick can't probe a closing backend and
    // log a false `unhealthy`. The `shuttingDown` latch above also makes an in-flight tick bail and never
    // reschedule; clearing the pending timer here closes the window between ticks.
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = null
    }

    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }

    // Drain a restart already in flight. The latch makes every QUEUED job a no-op, but a job that
    // began before the latch is mid `close() → listen() → registerAlias()` and must finish, or its
    // alias lands after the removal below. Never rejects (the chain self-catches).
    await this.restartWorkChain

    // And the background closure build, so its `turbo --dry` child never outlives the runner.
    await this.closureBuild

    // Layer B: deregister every portless alias BEFORE the child reap below. The reap can take
    // seconds (grace + SIGKILL escalation, per child), and a force-quit during it would otherwise
    // strand an alias pointing at a dead backend — the 502 you hit on the next start.
    //
    // Concurrent and best-effort: `removeAlias` never throws (the driver swallows failures) and each
    // call is self-bounded by the driver's own subprocess timeout, so this caps the pre-reap delay at
    // roughly one timeout regardless of alias count, and `Promise.all` cannot reject. That bound holds
    // only because `availability` is already warm here: an alias can exist only after `registerAlias`,
    // which awaits `isAvailable()`, and `ensureProxy` awaits it during `start()`. Register an alias
    // without a prior availability check and this silently becomes two subprocesses per alias.
    await Promise.all(
      [...this.registeredAliases].map((name) => {
        return this.proxy.removeAlias(name)
      }),
    )
    this.registeredAliases.clear()

    // Reap the long-lived engines (group SIGTERM→SIGKILL) so neither writes fresh dist nor
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

    // Strictly after the child is reaped: closing the tee first would drop its teardown output.
    if (this.uiLogStream) {
      this.uiLogStream.end()
      this.uiLogStream = null
    }

    for (const { app, server } of this.appServers) {
      try {
        await server.close()
      } catch {
        // ignore
      }
      // Remove this runner's own dev-context fragment so a stopped app drops out of the
      // helper's localSet (only its own — the directory model keeps runners independent).
      this.removeDevContextFragment(app)
    }

    // Final terminal-visible confirmation, so Ctrl-C never ends on a bare cursor. `log` (not the
    // verbose-only `narrate`) so the last line the user sees is always infra-kit's.
    //
    // Our own detached `turbo run dev` child writes its teardown to the log, not the TTY. Any pnpm
    // `ELIFECYCLE` still visible after Ctrl-C therefore comes from the `pnpm run` wrapper processes
    // ABOVE us in the shell's foreground process group (nested consumer scripts), which we cannot
    // redirect: the terminal signals the whole group, pnpm dies at once, and the shell redraws its
    // prompt while this teardown is still running. Fixing that means `exec`ing into the binary from
    // the consumer's dev script so no wrapper survives to report a failed child.
    this.renderer.log(`✓ dev stopped · logs → ${homeShorten(LOG_FILE_PATH)}`)
  }
}

/**
 * Select the terminal UI for this run: the persistent Ink UI on an interactive TTY (dynamically imported
 * so React never loads on the non-TTY / `--json` / MCP chunks), else the plain {@link DevRenderer}
 * (returned as `undefined` so the runner constructs its own default). `--json`/MCP always forces plain —
 * Ink must never seize a machine-readable stream.
 *
 * {@link PersistentInkDevUi} covers both shapes of session, branching at {@link DevUi.ready} on whether a
 * UI child owns the TTY, so there is nothing left to gate on here.
 */
const selectDevUi = async (options: DevServerOptions): Promise<DevUi | undefined> => {
  const isTTY = options.tty ?? Boolean(process.stdout.isTTY)

  if (!isTTY || options.json) {
    return undefined
  }

  const { PersistentInkDevUi } = await import('src/tui/dev-ui/persistent-ink-dev-ui')

  return new PersistentInkDevUi({ appendLog: appendLogFile, verbose: options.verbose ?? false })
}

/**
 * Construct a {@link DevServerRunner}, start it, and return the instance so the caller
 * (the CLI entry point) can wire signal handlers to `shutdown()` and own process exit.
 * Selects the boot UI (Ink on a TTY, plain otherwise) before constructing the runner.
 */
export async function run(options: DevServerOptions = {}): Promise<DevServerRunner> {
  const renderer = await selectDevUi(options)
  // Positions: options, runBuild, turboWatchFactory, uiDevFactory, dryRunner, renderer — pass `undefined`
  // for the injectable seams so their ctor defaults apply; only the renderer is chosen here.
  const runner = new DevServerRunner(options, undefined, undefined, undefined, undefined, renderer)

  // Unwind a partial boot. By the time `start()` can reject (e.g. a UI alias portless refuses), the
  // backends are already listening, aliased in the portless daemon, and recorded as dev-context
  // fragments on disk. The caller wires `shutdown()` to signals only AFTER this resolves, so without
  // this the process exits leaving external daemon state and on-disk fragments behind — the next
  // `vite dev` then proxies at an alias nothing serves. Teardown failures must not mask the original
  // boot error, so they are swallowed.
  try {
    await runner.start()
  } catch (error) {
    await runner.shutdown().catch(() => {})
    throw error
  }

  return runner
}
