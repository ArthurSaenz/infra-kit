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
 * Logs are written PER SERVICE under `<cacheRoot>/<INFRA_KIT_SESSION>/dev/<pid>/` — `runner.log` for the
 * runner's own narration, `<app>/api` and `<app>/ui` for each app, plus `turbo.log` (the UI engine's raw
 * chunk tee) and `watch.log`. Lambda / Powertools logs from handlers still go to stdout.
 */
import {
  DEFAULT_RELEASE_SLUG,
  DEV_CONTEXT_WIRE_VERSION,
  loadDev,
  slugifyHostLabel,
  slugifyRelease,
} from '@slip-stream-kit/config/internal'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { exec, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import util from 'node:util'

import { INFRA_KIT_ENV_VAR } from 'src/lib/constants'
import type { DevConfig, DevPreset, DevPresets, ProxySource } from 'src/lib/infra-kit-config'
import { DEFAULT_DEV_PROXY_PORT, getInfraKitConfig } from 'src/lib/infra-kit-config'

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
import { findDegradedRoutes, formatPairingRefusal } from './local-pairing.js'
import type { DegradedRoute, LaunchedUi } from './local-pairing.js'
import { currentService } from './log-attribution.js'
import { DevLogSink, panelStream } from './log-sink.js'
import { installOutputIntercept } from './output-intercept.js'
import type { OutputIntercept } from './output-intercept.js'
import {
  findPortConflicts,
  resolvePreferredPort as resolvePreferredPortPure,
  resolvePrefixUrl as resolvePrefixUrlPure,
} from './ports.js'
import { deriveTargetLabel, resolvePreset } from './presets.js'
import { createPortlessDriver, formatPortlessCommand, readCaPath } from './proxy/portless-driver.js'
import type { PortlessDriver } from './proxy/portless-driver.js'
import { DevRenderer, resolveEndpointUrl } from './render.js'
import type { DegradedRow, EndpointRow, ReadySummary, UiRef } from './render.js'
import { ServerlessLocalRun } from './serverless-local-run.js'
import { defaultTurboWatchFactory } from './turbo-watch.js'
import type { TurboWatchFactory, TurboWatchHandle } from './turbo-watch.js'
import { defaultUiDevFactory } from './ui-dev.js'
import type { UiDevFactory, UiDevHandle } from './ui-dev.js'

/**
 * The service tag every runner-authored line is filed under. Framework and request lines carry their own
 * app tag (`<app>/ui`, `<app>/api`); anything the runner itself says belongs here.
 */
const RUNNER_SERVICE = 'runner'

/**
 * The turbo child's RAW chunk tee — turbo's own run chrome plus every framework line, ANSI intact and
 * un-de-multiplexed. Kept as its own file rather than smeared across the per-app UI logs: a raw chunk
 * arrives before `parseTurboDevLine` has attributed it to a package, so there is no honest app to file
 * it under. The per-app `<app>/ui` files get the parsed, attributed lines.
 */
const TURBO_SERVICE = 'turbo'

/**
 * The `turbo watch build` engine's file. It is spawned with the log fd as its INHERITED stdio
 * (`turbo-watch.ts`), so it writes raw bytes straight into the file — which is exactly why it needs one
 * of its own rather than a share of any service's.
 */
const WATCH_SERVICE = 'watch'

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

/**
 * The process-wide per-service log sink. Created once at construction ({@link DevServerRunner}) and
 * closed in {@link DevServerRunner.shutdown}; module-scoped so the renderer's `appendLog` seam — which
 * is wired before `this` is fully initialised — can reach it.
 */
let logSink: DevLogSink | null = null

/** Tee a runner-authored line to `runner.log`. The seam {@link DevRenderer} wraps. */
function appendRunnerLog(text: string): void {
  logSink?.write(RUNNER_SERVICE, text)
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
   * is written to the per-service logs under `<cacheRoot>/<INFRA_KIT_SESSION>/dev/<pid>/` regardless of
   * this flag.
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

/** What a successful {@link DevServerRunner.startOneApp} hands back: a bound server and the alias it took. */
interface StartedApp {
  server: ServerlessLocalRun
  /** The ACTUAL port bound at start (ephemeral or preferred), reported by `server.start()`. */
  boundPort: number
  /** Layer-B alias host (`<release>.<package>.localhost`) — the app's only address. */
  alias: string
}

interface IAppServer {
  app: IApiAppConfig
  server: ServerlessLocalRun
  /** The ACTUAL port bound at start (ephemeral or preferred), reported by `server.start()`. */
  boundPort: number
  /** Layer-B alias host (`<release>.<package>.localhost`) — the app's only address. */
  alias: string
  /** Epoch ms of this server's last (re)start — the source of the panel's `up Xs` field. */
  startedAt: number
  /** Watch-triggered restarts so far. */
  restarts: number
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
  /** Wire version. See {@link DEV_CONTEXT_WIRE_VERSION} — a promise that `origin` is present. */
  v: number
  package: string
  port: number
  pid: number
  writtenAt: number
  release: string
  alias: string
  origin: string
}

/**
 * Every package that can supply the `infraKitDev` helper, with the lowest version of THAT package whose
 * helper understands the dev-context fragment's `origin` field.
 *
 * This is the load-bearing guard against version skew, and skew here is GUARANTEED rather than
 * hypothetical: the CLI is installed globally and **self-updates silently**, while the helper is PINNED
 * in each consumer's `node_modules`. So a new CLI routinely meets an old helper. An old helper ignores
 * `origin` and rebuilds the target from the consumer's `templates.local` — which still says `http://` —
 * and then proxies plain HTTP at a TLS listener. That failure is silent (portless answers :80 with a 302
 * rather than refusing), so nothing downstream would catch it. Refuse at start instead.
 *
 * A LIST, and each floor is a point on ITS OWN package's version line. This is the whole subtlety of the
 * `infra-kit` → `@slip-stream-kit/config` split, and getting it wrong fails silently in both directions:
 * - Comparing the new package's version against the OLD package's floor (`0.1.132`) is meaningless. The
 *   two are unrelated version lines; a new package seeded low would throw for every consumer, and one
 *   seeded high would pass vacuously — a dead guard that still looks alive.
 * - Simply RE-KEYING the guard to the new package (rather than adding to it) drops the old entry, and
 *   then a not-yet-migrated consumer — the exact population still running an old helper — silently stops
 *   being checked at all.
 *
 * So: keep them all, check whichever the repo actually resolves, and only drop the `infra-kit` entry once
 * no consumer imports `infra-kit/vite` any more. The packages release in LOCKSTEP, which is what keeps
 * each floor comparable to the CLI's own version as the wire evolves.
 *
 * `@slip-stream-kit/vite` (the plugin) needs its OWN entry even though it only wraps
 * `@slip-stream-kit/config`, and the reason is pnpm's layout rather than style: a consumer on the plugin
 * declares only the plugin, so `config` is a TRANSITIVE dep living in the virtual store — it resolves
 * from neither the app dir nor the repo root, and {@link assertHelperVersionFloor} would find nothing
 * to check and skip the repo entirely. The plugin's own `dependencies` pin the config version exactly
 * (`workspace:*` publishes as the released version), so checking the plugin checks the pair.
 */
export const HELPER_PACKAGES = [
  { name: '@slip-stream-kit/vite', floor: '0.1.134' },
  { name: '@slip-stream-kit/config', floor: '0.1.134' },
  { name: 'infra-kit', floor: '0.1.132' },
] as const

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

/** Package dirs whose manifest may declare a helper: the repo root, plus every `apps/<app>/{api,ui}`. */
const manifestDirs = (repoRoot: string): string[] => {
  const dirs = [repoRoot]

  try {
    for (const app of fs.readdirSync(path.join(repoRoot, 'apps'), { withFileTypes: true })) {
      if (!app.isDirectory()) continue
      for (const part of ['api', 'ui']) dirs.push(path.join(repoRoot, 'apps', app.name, part))
    }
  } catch {
    // No `apps/` dir — the root manifest alone decides.
  }

  return dirs
}

/** Does `<dir>/package.json` declare `name` in dependencies or devDependencies? */
const declaresPackage = (dir: string, name: string): boolean => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as Record<
      string,
      Record<string, string> | undefined
    >

    return ['dependencies', 'devDependencies'].some((field) => {
      return pkg[field]?.[name] != null
    })
  } catch {
    return false
  }
}

/**
 * Find the installed `name` by walking `node_modules` UPWARD from `fromDir`, exactly as Node resolves it.
 *
 * Probing `<repoRoot>/node_modules/<name>` alone — which is what this used to do — is wrong under pnpm,
 * and wrong in the direction that hurts. pnpm does NOT hoist a workspace package's dependency to the root:
 * a dep declared in `apps/client/ui/package.json` lands in `apps/client/ui/node_modules/`, and the root has
 * no trace of it. So the root-only probe would (a) fail to find — and therefore never version-check — a
 * helper declared where it is actually USED (next to the `vite.config.ts` that imports it), and (b) once
 * the consumer drops root `infra-kit` for the global CLI, report the correctly-installed helper as
 * "missing" and tell the user to run `pnpm install`, which can never fix it. Resolve it the way Node does.
 */
const findHelperDir = (repoRoot: string, fromDir: string, name: string): string | undefined => {
  const segments = name.split('/')
  let dir = fromDir

  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...segments)

    if (fs.existsSync(candidate)) return candidate

    const parent = path.dirname(dir)

    if (dir === repoRoot || parent === dir) return undefined
    dir = parent
  }
}

/**
 * `true` when `<repoRoot>/node_modules/<name>` is a workspace link back into this repo rather than a
 * published install.
 *
 * Resolves BOTH sides before comparing: on macOS a temp path realpaths from `/var` to `/private/var`, so
 * an unresolved root would never contain a resolved child and a workspace link would be misread as a
 * published install.
 */
const isWorkspaceLinked = (repoRoot: string, helperDir: string): boolean => {
  try {
    const real = fs.realpathSync(helperDir)
    const root = fs.realpathSync(repoRoot)

    return real.startsWith(root + path.sep) && !real.includes(`${path.sep}node_modules${path.sep}`)
  } catch {
    return false
  }
}

/** `realpath`, falling back to the input when it cannot be resolved (used only as a dedupe key). */
const safeRealpath = (target: string): string => {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/** Enforce one helper package's floor against ONE resolved install directory. */
const assertFloorAt = (repoRoot: string, name: string, floor: string, helperDir: string): void => {
  // In this repo `node_modules/@slip-stream-kit/config` symlinks to `apps/infra-kit/config`, whose
  // version is the unreleased working tree. Enforcing a floor there would brick `infra-kit dev` on the
  // very repo that develops it.
  if (isWorkspaceLinked(repoRoot, helperDir)) return

  let version: string

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(helperDir, 'package.json'), 'utf-8')) as { version?: string }

    if (typeof pkg.version !== 'string') throw new Error('no version field')
    version = pkg.version
  } catch {
    throw new Error(
      `infra-kit dev: could not read the version of the pinned \`${name}\` helper (${helperDir}). Refusing ` +
        `to start rather than risk proxying plain HTTP at a TLS listener. Run \`pnpm install\`.`,
    )
  }

  if (isBelowVersion(version, floor)) {
    throw new Error(
      `infra-kit dev: this repo pins ${name} ${version}, but dev URLs are now HTTPS and the ` +
        `\`infraKitDev\` helper only understands them from ${floor}. An older helper would proxy plain ` +
        `HTTP at a TLS listener — silently. Bump the dependency:\n` +
        `    pnpm add -D ${name}@^${floor}`,
    )
  }
}

/**
 * Refuse to start against a consumer-pinned `infraKitDev` helper too old to understand the dev-context
 * fragment's `origin` field — whichever package that helper comes from (see {@link HELPER_PACKAGES}).
 *
 * Every helper package is checked INDEPENDENTLY, and every place it resolves from is checked. Two
 * migration shapes make that necessary rather than fussy:
 * - A repo mid-migration has BOTH (`@slip-stream-kit/config` added, `infra-kit` not yet dropped), and its
 *   vite configs may still import from either. Stopping at the first helper that passes would hand exactly
 *   that repo a silent HTTP-into-TLS proxy from the other one.
 * - Under pnpm the helper usually resolves NOT from the repo root but from the package that declares it —
 *   `apps/client/ui/node_modules/` sits right next to the `vite.config.ts` that imports it. See
 *   {@link findHelperDir}.
 *
 * Three outcomes per package, and the reasoning for each matters:
 * - **Workspace-linked → SKIP** (that install only; every other one is still checked).
 * - **Declared but unresolvable → THROW (fail closed).** The consumer says it uses a helper and we
 *   cannot prove which version; guessing is how the silent case ships.
 * - **Neither installed nor declared → SKIP.** Nothing to be skewed against. (This is also what keeps
 *   bare test fixtures runnable.)
 */
export const assertHelperVersionFloor = (repoRoot: string): void => {
  const dirs = manifestDirs(repoRoot)

  for (const { name, floor } of HELPER_PACKAGES) {
    const declaredIn = dirs.filter((dir) => {
      return declaresPackage(dir, name)
    })

    // Always probe the root too: a helper can be present without being declared (hoisted, or a transitive
    // of something else), and it would still be the one vite resolves.
    const resolved = new Map<string, string>()

    for (const dir of [...declaredIn, repoRoot]) {
      const found = findHelperDir(repoRoot, dir, name)

      // Key by realpath: several packages symlinking into the same pnpm store entry are ONE install, and
      // re-reading it per app would just multiply identical work (and identical error messages).
      if (found) resolved.set(safeRealpath(found), found)
    }

    if (resolved.size === 0) {
      if (declaredIn.length === 0) continue

      throw new Error(
        `infra-kit dev: ${declaredIn[0]}/package.json depends on ${name} but it does not resolve from there, ` +
          `so the \`infraKitDev\` helper version cannot be verified. Run \`pnpm install\`.`,
      )
    }

    for (const helperDir of resolved.values()) assertFloorAt(repoRoot, name, floor, helperDir)
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
  /** Per-app request timestamps, pruned to a 60s window — the panel's `18/min` field. */
  private readonly reqTimes = new Map<string, number[]>()
  /**
   * The last {@link ReadySummary} painted. Kept so {@link refreshStatus} can repaint the panel with
   * fresh live fields without re-deriving the static half (URLs, aliases, watch summary) every tick.
   */
  private lastSummary: ReadySummary | null = null
  /** Epoch ms at which the session went ready — the source of the panel's heartbeat. */
  private readyAt = 0
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
   * Per-service log files. One held fd per service — so a chunk tee during an HMR burst is a single
   * `writeSync` on an already-open fd, not the open/write/close that the old `appendFileSync` paid per
   * call, and there is no buffered stream whose tail a hard exit could drop.
   */
  private readonly sink: DevLogSink
  /**
   * Owns `console` + the raw stream writes for the life of a TTY session, routing every line into its
   * service's file. `null` on a `--json` / MCP / piped run, where stdout must stay byte-clean.
   */
  private readonly intercept: OutputIntercept | null
  /** `turbo --dry` closure-source seam — real turbo (via {@link buildClosureMap}'s default) unless injected for tests. */
  private readonly dryRunner: DryRunner | undefined
  /** Apps that threw during {@link startAllApps} — rendered as `● failed` rows by {@link printReady}. */
  private readonly failedApps: { app: IApiAppConfig; reason: string }[] = []

  /**
   * Routes that wanted a local backend and lost it to a start failure (see `local-pairing.ts`). Computed
   * once, right after {@link startAllApps} — it is a fact about the boot, and the panel re-derives which
   * of them are STILL degraded on every repaint from the running set.
   */
  private degradedRoutes: DegradedRoute[] = []
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
    this.sink = new DevLogSink()
    logSink = this.sink

    // Install EARLY and FILE-ONLY: an app's log line never reaches the terminal, at any point. Early,
    // because handler modules are imported during boot — long before the panel exists — so a late
    // install would let their import-time output escape onto the screen, which is the leak this whole
    // mechanism exists to prevent (a Powertools `Server listening` banner printed above the panel).
    //
    // No tee window, and no boot crash is lost to it: Node writes a fatal stack STRAIGHT TO FD 2 (never
    // through the patched stream), a rejected `start()` surfaces after `shutdown()` has already called
    // `uninstall()`, and a post-`ready()` fault goes through `reportFault` onto the panel.
    this.intercept = ownsTerminal(this.options)
      ? installOutputIntercept({ sink: this.sink, fallbackService: RUNNER_SERVICE, currentService })
      : null
    // The renderer owns all terminal output + the log tee; construct it before the first narrate below.
    this.renderer = renderer ?? new DevRenderer({ appendLog: appendRunnerLog, verbose: this.options.verbose ?? false })
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

    const { apps, uiApps, apiAppsAll, uiAppsAll, wantedLocalPkgs, presetProxy } = await this.resolveRunPlan(
      devConfig,
      include,
    )

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
      this.renderer.narrate(`📝 Logs → ${homeShorten(this.sink.dir)} (one file per service)`)
    }

    // The label for what the user asked to run. Derived from the post-`--app` sets — not from
    // `options.preset` (unset for the wizard's in-memory preset) nor from `include` (app names only).
    // Hoisted above the refusal below so both it and the ready header name the run the same way.
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

    // A backend that was asked for and died takes its frontend's `local` routes down with it — silently,
    // to cloud. Refuse BEFORE printReady: a refusal must not register portless aliases or spawn a vite it
    // is about to abandon, and the message carries the backend's real error, so there is nothing left in
    // the header the user still needs.
    //
    // `--watch` is the one exception, and only because it can genuinely fix this: a boot-failed app is a
    // restart target now (see {@link resolveRestartTargets}), so the next save can bring the backend up
    // and the route back to local. It stays resident with a loud, self-clearing `⚠ … ● cloud` row instead.
    //
    // That healing is real, and it is the `infraKit()` vite PLUGIN that makes it real: its `configureServer`
    // hook watches the dev-context fragment dir, re-resolves the proxy, and restarts vite when the resolved
    // map changes (verified live — `[vite] server restarted.` the moment a fragment appears). A UI that
    // instead wires the bare `infraKitDev()` helper directly in its vite config has NO such watcher: its
    // proxy is baked at config load, so a backend recovering mid-session will not flip its route back to
    // `local` until that UI is restarted. Discovery treats both shapes as managed, so on such a UI this row
    // can clear while the traffic still goes to cloud. The plugin is the supported wiring and every
    // consumer uses it today; stated here so the assumption is on the record rather than merely held.
    this.degradedRoutes = await this.collectDegradedRoutes(uiApps, wantedLocalPkgs, presetProxy)
    if (this.degradedRoutes.length > 0 && !watch) {
      throw new Error(formatPairingRefusal(this.degradedRoutes, target))
    }

    // Collapse the boot spinner into the calm ready header (BE endpoints + UI reference lines).
    // Runs for a UI-only session too, so it never leaves a blank screen. The route dump is opt-in.
    await this.printReady(apps, uiApps, bootStart, target)
    if (this.options.routes) {
      this.printRouteDump()
    }

    // Everything the user asked for is dead and there is no UI to fall back on: there is nothing left
    // to serve, watch, or proxy. Resident-but-empty is the worst of both worlds — it looks like a
    // running dev server and exits 0 when finally interrupted, so a CI step or a script would call it
    // a success. Fail loudly instead. A PARTIAL failure stays resident: the survivors are still useful,
    // and under `--watch` a boot-failed app IS retried on the next save ({@link resolveRestartTargets}) —
    // without `--watch` it is gone for the session, which is why a broken local pairing refuses above.
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

    // Armed UNCONDITIONALLY, including for a UI-only session with nothing to probe.
    //
    // The tick does two jobs now: it probes backend health, and it repaints the status panel. The probe
    // half is a backend concern; the repaint half is not — and gating the whole timer on
    // `appServers.length > 0` gated the PANEL on a backend existing. A UI-only session painted once at
    // boot and then froze: a `⚠ 0` row held forever while vite piped compile errors into its log file
    // and the counter behind the row climbed unread. A green row over a broken UI is precisely the lie
    // this design exists to prevent, and it is worse here than the tail it replaced, because there is no
    // longer anything else on screen to contradict it.
    //
    // Over an empty `appServers` the probe half is `Promise.all([])` — free. The timer is `unref`'d, so
    // it cannot hold the loop open on its own.
    this.startLivenessMonitor()
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
    /**
     * Backend packages the PRESET promised to serve locally, captured BEFORE `--app`/`--self` narrowing.
     * Narrowing changes what runs; it does not change what the preset promised, and a backend dropped by
     * a narrowing flag is never attempted — so it never lands in `failedApps` and a crash-keyed check
     * would say nothing while its frontend quietly proxied to cloud. See `local-pairing.ts`.
     */
    wantedLocalPkgs: Set<string>
    /** The preset's declared per-route proxy overrides (`app → route → source`), for `pinnedLocal`. */
    presetProxy: Record<string, Record<string, ProxySource>>
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

    // Every api the PRESET names, pre-`passesInclude` — the promise, not the survivors.
    const wantedLocalPkgs = new Set(
      apiAppsAll
        .filter((a) => {
          return apiNames.has(a.name)
        })
        .map((a) => {
          return a.packageName
        }),
    )

    return { apps, uiApps, apiAppsAll, uiAppsAll, wantedLocalPkgs, presetProxy: resolved.proxy }
  }

  /**
   * Which of this run's routes are about to be silently misrouted to cloud, because the local backend
   * they name failed to start (see `local-pairing.ts` for why this is the dangerous half).
   *
   * Reads each launched frontend's own `infra-kit.config.ts` — the SAME file, through the same loader,
   * that the vite helper will read when it resolves the proxy. That is deliberate: any second source of
   * truth here could disagree with the proxy the frontend actually ends up serving, and a disagreement
   * would either cry wolf or (far worse) stay quiet on a real one. A frontend with no `dev.proxy` block
   * declares no routes and can degrade nothing.
   */
  private async collectDegradedRoutes(
    uiApps: DiscoveredUiApp[],
    wanted: ReadonlySet<string>,
    presetProxy: Record<string, Record<string, ProxySource>>,
  ): Promise<DegradedRoute[]> {
    if (uiApps.length === 0) return []

    const uis: LaunchedUi[] = []

    for (const ui of uiApps) {
      // A config that throws must not take the run down here: the frontend is about to load the very same
      // file itself and will report it far better than this check can. Treat it as "declares no routes"
      // and let vite own the error.
      const dev = await loadDev(ui.path).catch(() => {
        return undefined
      })

      if (!dev?.proxy) continue

      const overrides = presetProxy[ui.name] ?? {}
      const routes = Object.fromEntries(
        Object.entries(dev.proxy.routes).map(([route, spec]) => {
          return [route, { ...spec, pinnedLocal: overrides[route] === 'local' }]
        }),
      )

      uis.push({ app: ui.name, routes, cloudTemplate: dev.proxy.templates.cloud })
    }

    return findDegradedRoutes({
      uis,
      wanted,
      // REALITY: the packages actually serving. `appServers` holds exactly the apps that bound a port and
      // wrote a dev-context fragment — which is the same fact the vite helper reads to decide `local`.
      running: new Set(
        this.appServers.map(({ app }) => {
          return app.packageName
        }),
      ),
      reasons: new Map(
        this.failedApps.map(({ app, reason }) => {
          return [app.packageName, { app: app.name, reason }]
        }),
      ),
      env: process.env[INFRA_KIT_ENV_VAR],
    })
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

    this.uiDev = this.uiDevFactory({
      packageNames: uiApps.map((a) => {
        return a.packageName
      }),
      cwd: process.cwd(),
      concurrency: Math.max(uiApps.length + 4, 12),
      env: uiPortEnv || caEnv ? { ...uiPortEnv, ...caEnv } : undefined,
      // The RAW chunk tee: turbo's chrome plus every framework line, un-de-multiplexed. It arrives
      // before `parseTurboDevLine` has attributed it to a package, so there is no honest app to file it
      // under — it gets its own `turbo.log`. The attributed lines land in `<app>/ui` below.
      appendLog: (text) => {
        this.sink.write(TURBO_SERVICE, text)
      },
      onLine: ({ pkg, text, level }) => {
        const tag = tagByPackage.get(pkg) ?? `${pkg}/ui`

        this.sink.write(tag, text, { level })
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
            this.appServers.push({ app, ...started, startedAt: Date.now(), restarts: 0 })
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

  private async startOneApp(app: IApiAppConfig): Promise<StartedApp | null> {
    this.renderer.narrate(`🔄 Starting ${app.name}...`)

    // No `process.chdir` here: `ServerlessLocalRun` reads `serverless.yml` and imports the
    // compiled handler from `controllersPath` (absolute), so the runner never mutates cwd —
    // which is what makes concurrent boot/restart safe.
    const server = new ServerlessLocalRun({
      controllersPath: app.path,
      prefixUrl: app.prefixUrl,
      port: app.preferredPort,
      appName: app.name,
      // Claims every line this app's handlers emit — `console.log`, Powertools, a dependency's banner —
      // for `<app>/api`, via an AsyncLocalStorage context entered in the request's `onRequest` hook and
      // around the handler module's import.
      //
      // Without it NOTHING attributes: the backend is in-process and multi-app, so a raw stdout write
      // says nothing about which app produced it, and every handler line falls into the runner's
      // fallback bucket. The app's row then counts zero errors no matter how loudly its handler fails —
      // which, with no log tail on screen, means the panel reports a healthy app that is broken.
      serviceTag: `${app.name}/api`,
      // Route live request traffic into the renderer's tagged, timestamped tail (`<app>/api …`).
      // This is the structured seam — independent of the legacy `DEV_SERVER_REQUEST_LOG` raw line —
      // so the app name is threaded in-process and never leaked to spawned turbo/vite children.
      onRequestLog: ({ method, path: reqPath, status, ms }) => {
        // Keep the runner's own `/__health` liveness probes out of the live tail — they are internal
        // noise, not app traffic. Real handler routes still stream.
        if (reqPath === '/__health') return

        const tag = `${app.name}/api`
        const text = `${method} ${reqPath} ${status} ${ms}ms`

        // The level is DECLARED, not sniffed: fastify already knows the status it returned. A 5xx is an
        // error because the server said so — no regex ever reads this line's bytes to decide.
        this.sink.write(tag, text, { level: status >= 500 ? 'error' : 'info' })
        // Mutate in place: spreading into a fresh array copied the whole window on every single request.
        const window = this.reqTimes.get(tag)

        if (window) window.push(Date.now())
        else this.reqTimes.set(tag, [Date.now()])
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
      // Declares the wire contract this fragment honours, so the helper never has to INFER it from a
      // package version — which stopped being inferable the moment the helper moved to its own npm
      // package with its own version line. `v` promises `origin` below is present and authoritative; the
      // helper refuses rather than guessing a target if that promise is ever broken.
      v: DEV_CONTEXT_WIRE_VERSION,
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
        // `idx >= 0` is a RUNNING app — the ordinary restart. `idx === -1` plus a `failedApps` entry is an
        // app that never came up at all, and it is a restart target precisely because it isn't running:
        // watch used to filter it out, which meant a backend that died on boot stayed dead for the whole
        // session no matter how many times you fixed and saved the file that broke it. Its frontend sat
        // there proxying to cloud the entire time. Everything else — an app the run never launched — is
        // neither, and is correctly skipped.
        return t.idx >= 0 || this.isFailedApp(t.app.name)
      })
  }

  /** Did this app fail to start (and is therefore still absent from {@link appServers})? */
  private isFailedApp(name: string): boolean {
    return this.failedApps.some((f) => {
      return f.app.name === name
    })
  }

  /**
   * Promote an app that just came back from the dead: it has no {@link appServers} slot to overwrite, so
   * it is appended, cleared from `failedApps`, and given the endpoint row the boot header never made for
   * it. Without that last step the panel — which maps over `lastSummary.endpoints` — would keep the
   * app invisible even though it is now serving.
   */
  private promoteRecoveredApp(app: IApiAppConfig, started: StartedApp): IAppServer {
    const entry: IAppServer = { app, ...started, startedAt: Date.now(), restarts: 0 }

    // Seed the liveness counter BEFORE the app is visible in `appServers`, not after the probe the caller
    // takes a few lines later. `refreshStatus` derives the health dot from this map and treats an ABSENT
    // entry as zero failures — i.e. green. The liveness tick can fire in the window between the push below
    // and that probe, and it would paint a green dot for a server nothing has yet asked a single question.
    // One notional failure is the honest prior: not yet proven up. The probe overwrites it either way.
    this.livenessFailures.set(app.name, 1)
    this.appServers.push(entry)

    const failedIdx = this.failedApps.findIndex((f) => {
      return f.app.name === app.name
    })

    if (failedIdx >= 0) this.failedApps.splice(failedIdx, 1)

    const tag = `${app.name}/api`

    if (this.lastSummary) {
      this.lastSummary = {
        ...this.lastSummary,
        endpoints: [
          ...this.lastSummary.endpoints,
          {
            tag,
            url: resolveEndpointUrl({ prefixUrl: app.prefixUrl, alias: started.alias }),
            // NOT `true`. This app has bound a port; nothing has probed it. A server that binds and then
            // 500s on `/__health` would be painted green here on the strength of having started — the same
            // unearned claim the `● failed` row exists to prevent. `null` = no dot; the caller probes right
            // after and {@link refreshStatus} paints the answer.
            healthy: null,
          },
        ],
        failed: (this.lastSummary.failed ?? []).filter((f) => {
          return f.tag !== tag
        }),
      }
    }

    return entry
  }

  private async runRestart(apps: IApiAppConfig[]): Promise<void> {
    const targets = this.resolveRestartTargets(apps)

    if (targets.length === 0) return

    const label = targets.length === 1 ? targets[0]!.app.name : `${targets.length} apps`

    this.renderer.log(`🔄 Restarting ${label}...`)
    await Promise.all(
      targets.map(async ({ idx }) => {
        // A boot-failed target (`idx === -1`) has no server to close — it never bound one. Only a running
        // app is torn down before its replacement starts.
        if (idx < 0) return

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
            // A boot-failed app has no slot to overwrite: it is APPENDED and cleared from `failedApps`,
            // which is also what takes its frontend's `⚠ … ● cloud` row down (see {@link degradedRows}).
            if (idx < 0) {
              const recovered = this.promoteRecoveredApp(app, restarted)

              this.renderer.log(`✅ ${app.name} recovered — its routes are served locally again`, 'info')

              return { app, entry: recovered }
            }

            // Carry the restart count forward across the replacement and reset the clock: `up Xs` must
            // measure THIS process, not the one watch just killed, or the panel would claim an uptime
            // for a server that has been alive for two seconds.
            const previous = this.appServers[idx]
            const entry: IAppServer = {
              app,
              ...restarted,
              startedAt: Date.now(),
              restarts: (previous?.restarts ?? 0) + 1,
            }

            this.appServers[idx] = entry

            return { app, entry }
          }

          return { app, entry: null }
        } catch (error) {
          // A target that was ALREADY failed stays failed — it keeps its `failedApps` entry and its
          // frontend keeps the degraded row. Only report the reason; a retry that fails again is the
          // expected case while the user is still fixing the bug that broke it.
          this.renderer.log(`❌ Failed to ${idx < 0 ? 'start' : 'restart'} ${app.name}: ${String(error)}`, 'error')

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

        // Seed the liveness counter from the probe we just took, instead of leaving it at its absent-is-0
        // default. `refreshStatus` derives the panel's health dot from THIS map, so a restarted server
        // that binds its port but 500s on `/__health` would otherwise be painted green for a full
        // LIVENESS_INTERVAL_MS while this very function logs it as `● down` — the panel and the log
        // disagreeing about the same probe.
        this.livenessFailures.set(app.name, healthy ? 0 : 1)

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
      // `turbo watch build` opens this path itself and inherits it as its stdio, so the watch engine
      // gets its own file rather than interleaving raw child bytes into any service's log.
      logFile: this.sink.pathFor(WATCH_SERVICE),
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
  /**
   * Repaint the status panel with fresh live fields (health, uptime, req/min, restarts, errors).
   *
   * This is the first caller `DevUi.refresh()` has ever had: it was declared, implemented twice, and
   * invoked from nowhere, so the "live" footer has always painted boot-time values that never changed.
   * That was survivable while a log tail scrolled beside it. It is not survivable now — with nothing
   * else on screen, a panel that never moves cannot be told apart from a hung process.
   */
  private refreshStatus(): void {
    const summary = this.lastSummary

    if (summary == null) return

    const now = Date.now()
    const byTag = new Map<string, IAppServer>(
      this.appServers.map((server) => {
        return [`${server.app.name}/api`, server]
      }),
    )

    // Prune FIRST, unconditionally, and never inside the argument to `refresh?.()`: an optional call
    // does not evaluate its argument at all when the method is absent, and `DevRenderer` — the renderer
    // on every `--json` / MCP / piped run — has no `refresh`. Pruning in there meant the window was never
    // trimmed off the TTY path, so `reqTimes` grew without bound while `onRequestLog` copied the whole
    // array on every request. Unbounded memory and O(n²) CPU, on the long-lived MCP path specifically.
    this.pruneRequestWindow(now)

    this.renderer.refresh?.({
      ...summary,
      sessionUptimeMs: now - this.readyAt,
      // Re-derived, never carried over from the boot summary: a `--watch` restart that brings the backend
      // back must take this row down with it (see {@link degradedRows}).
      degraded: this.degradedRows(),
      // A UI with no managed port has no endpoint row — only a reference line. It still gets its error
      // count, or its breakage would be counted into a file with nothing on screen pointing at it.
      uiRefs: summary.uiRefs.map((ref) => {
        return { ...ref, errors: this.sink.statsFor(ref.tag).errors }
      }),
      endpoints: summary.endpoints.map((endpoint) => {
        const server = byTag.get(endpoint.tag)

        return {
          ...endpoint,
          // A UI row has no backend server, so it has no health probe and no uptime — but it DOES have
          // an error count, which is the whole reason the panel can report a broken frontend at all.
          healthy: server ? (this.livenessFailures.get(server.app.name) ?? 0) === 0 : endpoint.healthy,
          uptimeMs: server ? now - server.startedAt : undefined,
          restarts: server?.restarts,
          rpm: (this.reqTimes.get(endpoint.tag) ?? []).length,
          errors: this.sink.statsFor(endpoint.tag).errors,
        }
      }),
    })
  }

  /**
   * The degraded routes that are STILL degraded — i.e. whose backend is not (yet) running.
   *
   * Re-derived from the live `appServers` set rather than cached, because under `--watch` this is the
   * one row on the panel that is supposed to disappear: the whole point of retrying a boot-failed app is
   * that the route it broke goes back to local. A row that outlived its cause would be a permanent
   * warning about a fixed condition, and a warning that is always on is a warning nobody reads.
   *
   * Membership in `appServers` is the right test: {@link startAllApps} pushes only apps that booted, and
   * {@link runRestart} pushes a recovered app in at the moment it does — which is also the moment its
   * dev-context fragment lands, i.e. exactly when the vite helper flips the route back to `local`.
   */
  private degradedRows(): DegradedRow[] {
    if (this.degradedRoutes.length === 0) return []

    // Keyed by PACKAGE, not by app folder: a route degraded because the run never launched its backend
    // has no owning app name at all (`apiApp` is undefined), and the package is the identity the route,
    // the fragment, and the vite helper's local set all agree on.
    const running = new Set(
      this.appServers.map(({ app }) => {
        return app.packageName
      }),
    )

    return this.degradedRoutes
      .filter((d) => {
        return !running.has(d.packageName)
      })
      .map((d) => {
        return { route: d.route, tag: `${d.uiApp}/ui`, fallback: d.fallback, target: d.cloudTarget }
      })
  }

  /** Drop request timestamps older than the 60s rpm window. Runs on every tick, painting or not. */
  private pruneRequestWindow(now: number): void {
    const cutoff = now - 60_000

    for (const [tag, times] of this.reqTimes) {
      this.reqTimes.set(
        tag,
        times.filter((at) => {
          return at > cutoff
        }),
      )
    }
  }

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

    // The panel's heartbeat. It rides the probe tick that already exists rather than adding a timer of
    // its own, so the numbers on screen are exactly as fresh as the health behind them.
    this.refreshStatus()
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

    this.lastSummary = {
      target,
      watch,
      release: readAppRelease(process.cwd()),
      elapsedMs,
      endpoints: [...endpoints, ...uiEndpoints],
      uiRefs,
      failed: this.failedApps.map(({ app, reason }) => {
        return { tag: `${app.name}/api`, reason }
      }),
      degraded: this.degradedRows(),
      watchSummary: `${appCount} app${appCount === 1 ? '' : 's'} · ${pkgCount} package${pkgCount === 1 ? '' : 's'}`,
      // The DIRECTORY, not a file: there is one log per service now, so a single path would have to
      // pick a favourite. `tail -f <dir>/<service>.log` is the workflow.
      logPath: homeShorten(this.sink.dir),
      logHref: this.sink.dir,
    }

    // Paint the boot frame from the same summary the panel will keep repainting, so the header and the
    // live rows can never disagree about what is running.
    this.readyAt = Date.now()
    this.renderer.ready(this.lastSummary)
    this.refreshStatus()
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
  /**
   * Report a process-level fault — an `uncaughtException` / `unhandledRejection` the crash barrier caught
   * and deliberately survived.
   *
   * This exists because the interceptor owns `process.stderr` for the life of a TTY session. The crash
   * barrier's own reporter is a plain `process.stderr.write`, so after `ready()` a crash would be FILED
   * into a log and never printed — leaving a panel that still says `● ok` and `⚠ 0` over a session that
   * has just faulted. Silence is the one thing a fault may never produce, and the panel is now the only
   * signal there is.
   *
   * So a fault takes both channels, deliberately: it is filed at `error` level (which turns the row's
   * counter red) AND punched onto the terminal through the panel's bypass, which steps over the very
   * patch that would otherwise swallow it. Attributed to the app whose async context faulted, when
   * there is one.
   */
  public reportFault(detail: string): void {
    // File it against the app whose async context faulted — that is what turns its row's counter red.
    this.sink.write(currentService() ?? RUNNER_SERVICE, detail, { level: 'error' })

    // Print it through the UI, NOT through the bypass. `rawStdoutWrite` would push N raw lines onto a
    // terminal whose live region Ink believes it owns: Ink erases by counting rows back from where it
    // thinks the cursor is, so the very next repaint (≤5s away, on the liveness tick) would erase the
    // tail of this stack and leave a ghost of the old panel above it. The method exists to make a fault
    // impossible to miss; writing it somewhere the next frame deletes it is worse than not writing it.
    //
    // `renderer.log` commits through Ink's `<Static>` region, which survives every repaint — and falls
    // through to a plain stdout write on the non-TTY renderer, where there is no region to respect.
    this.renderer.log(detail, 'error')
  }

  public async shutdown(): Promise<void> {
    // Latch BEFORE anything else. Everything below assumes no new alias can be registered once
    // teardown begins; `scheduleDebounced` and `restart` read this flag to honour that.
    this.shuttingDown = true

    // Release the terminal FIRST: if the Ink boot UI is still mounted (e.g. SIGINT mid-boot), unmount it
    // before any plain write below, so the shutdown lines never clobber a live region. No-op for the
    // plain renderer and idempotent when Ink already unmounted at ready().
    this.renderer.dispose()

    // Hand `console` and the raw streams back HERE — before the first shutdown line, not after the last.
    // `dispose()` drops the panel, so `renderer.log` below falls through to a plain `process.stdout`
    // write; while the interceptor still owned it and was suppressing, that line went to a log file. The
    // user pressed Ctrl-C and then watched a dead terminal for the seconds teardown takes (killing the
    // turbo tree escalates SIGTERM→SIGKILL per child) — which is exactly how a second Ctrl-C gets
    // pressed, taking the force-quit path and orphaning the children.
    this.intercept?.uninstall()

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
    // Hand `console` and the raw streams back BEFORE the final line prints, so the goodbye actually
    // reaches the terminal instead of being filed into a log the user is no longer watching.
    this.intercept?.uninstall()

    this.renderer.log(`✓ dev stopped · logs → ${homeShorten(this.sink.dir)}`)

    // Strictly last: every line above still has to reach a file. Closing holds no buffered data (the
    // sink writes through a held fd), so this only releases the fds.
    this.sink.close()
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
/**
 * Whether this run owns the terminal — the single gate for BOTH the live UI and the output interception.
 *
 * Derived once and shared, never re-derived: a `--json` / MCP / piped run must keep a byte-clean stdout,
 * and interception there would file the machine-readable stream into a log and hand the caller nothing.
 */
export const ownsTerminal = (options: DevServerOptions): boolean => {
  return (options.tty ?? Boolean(process.stdout.isTTY)) && !options.json
}

const selectDevUi = async (options: DevServerOptions): Promise<DevUi | undefined> => {
  if (!ownsTerminal(options)) {
    return undefined
  }

  const { PersistentInkDevUi } = await import('src/tui/dev-ui/persistent-ink-dev-ui')
  const { createSafeStream } = await import('src/tui/safe-stderr')

  return new PersistentInkDevUi({
    appendLog: appendRunnerLog,
    verbose: options.verbose ?? false,
    // Composition order is load-bearing. The BYPASS proxy is inside (its `write` reaches the real
    // terminal, stepping over the interceptor's patch); the SCRUB proxy is outside (it strips the
    // `ESC[3J` that an overflowing Ink frame emits, which would wipe the user's scrollback).
    //
    // Inverting them breaks silently: `createSafeStream` resolves `target.write` at CALL time, so
    // wrapping the raw `process.stdout` would route every frame through the patch and into a log file —
    // a blank screen with no error anywhere.
    stdout: createSafeStream(panelStream()),
  })
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
