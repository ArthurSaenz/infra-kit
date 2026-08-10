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

import { buildClosureMap, selectPackageRestartTargets } from './dep-closure.js'
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
  usesInfraKitVitePlugin,
} from './discovery.js'
import type { DiscoveredUiApp } from './discovery.js'
import { findDegradedRoutes, formatPairingRefusal, resolveProxyRoutes } from './local-pairing.js'
import type { DegradedRoute, LaunchedUi, ResolvedProxyRoute } from './local-pairing.js'
import { currentService } from './log-attribution.js'
import { DevLogSink, panelStream } from './log-sink.js'
import {
  installModuleGeneration as installGenerationHook,
  isModuleGenerationSupported,
  resolveStopBudget,
  selfDistDir,
} from './module-generation.js'
import type { ModuleGenerationHandle } from './module-generation.js'
import { installOutputIntercept } from './output-intercept.js'
import type { OutputIntercept } from './output-intercept.js'
import {
  findPortConflicts,
  resolvePreferredPort as resolvePreferredPortPure,
  resolvePrefixUrl as resolvePrefixUrlPure,
} from './ports.js'
import { buildPresetProxyContext } from './preset-proxy-context.js'
import { deriveTargetLabel, resolvePreset, validatePresetKeys, validatePresetProxy } from './presets.js'
import type { DiscoveredParts } from './presets.js'
import { createPortlessDriver, formatPortlessCommand, readCaPath } from './proxy/portless-driver.js'
import type { PortlessDriver } from './proxy/portless-driver.js'
import { describeStaleFiles, isHotReloadableChange } from './reload-scope.js'
import { DevRenderer, resolveEndpointUrl } from './render.js'
import type { DegradedRow, EndpointRow, HealthState, ProxyRouteRow, ReadySummary, UiRef } from './render.js'
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

/** Bytes as whole megabytes with a unit — the only shape process size is ever shown in. */
const megabytes = (bytes: number): string => {
  return `${Math.round(bytes / 1_000_000)} MB`
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

export const launchScript = async (script: string, logFn?: LogFn): Promise<void> => {
  try {
    // 32 MB (parity with the dep-closure dry-runner) instead of exec's 1 MB default: a failing `turbo run
    // build` easily emits >1 MB of tsc diagnostics, which would reject with ERR_CHILD_PROCESS_STDIO_MAXBUFFER
    // and MASK the real compile errors — surfacing a bogus "maxBuffer exceeded" instead of the actual failure.
    const { stderr } = await execFn(script, { maxBuffer: 32 * 1024 * 1024 })

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
  /**
   * The same resolution with the bare `PORT` tier DENIED — `{APP}_PORT` or `dev.<app>.port` only.
   *
   * Both are resolved together in {@link DevServerRunner.discoverApiApps} because that is where
   * `devConfig` is in scope, but the CHOICE between them cannot be made there: it depends on how many
   * apps this run actually launches, and narrowing to the run plan happens later
   * ({@link DevServerRunner.resolveRunPlan}). A bare `PORT` is not app-scoped, so in a multi-app run it
   * gives every app the same preferred port and {@link DevServerRunner.assertNoPortConflicts} then
   * refuses to start over duplicates the environment manufactured. Carrying both values forward is what
   * lets a single-app run keep honouring `PORT` while a multi-app run ignores it.
   */
  appScopedPort: number | undefined
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
  /**
   * Probe the frontends' liveness (vite's HMR ping) and give their rows a health dot. Default `true`;
   * `--no-ui-health` / `INFRA_KIT_NO_UI_HEALTH=1` turns it off, which drops every UI row back to no dot
   * at all and issues zero UI probes. The escape hatch exists because the ping is an undocumented vite
   * internal: if a future vite drops it, the dot has to be switchable off without a CLI downgrade.
   */
  uiHealth?: boolean
  /**
   * Ask the entry point to terminate the process, with the code to exit on.
   *
   * The runner has no business calling `process.exit` itself — `shutdown()` deliberately stops at
   * releasing resources and leaves the process's fate to whoever owns it. But the reload budget's stop
   * has nowhere else to go: it reaches neither the signal handler nor the fatal handler, and teardown
   * alone would leave a live terminal with every server already dead. The entry wires this to the SAME
   * `exit` seam `registerSignalShutdown` receives, so a budget stop and a Ctrl-C end the process
   * through one path. Absent (tests, embedded callers) the runner tears down and returns.
   */
  onExitRequest?: (code: number) => void
}

/** What a probe is aimed at. `kind` picks the endpoint AND the verdict rules — the two are not separable. */
export interface ProbeTarget {
  /** Stream tag (`<app>/api`, `<app>/ui`) — the key the health map and every log line agree on. */
  tag: string
  /** The port to probe: a backend's ACTUAL bound port, or a UI's runner-assigned vite port. */
  port: number
  kind: 'api' | 'ui'
}

/**
 * Something answered, but not the thing we asked for — and WHAT it answered is the whole diagnostic.
 *
 * A UI's `foreign` never paints red (see {@link ProbeOutcome}), so this line is the only thing the user
 * gets, and "not vite's ping" alone cannot separate the three causes it exists to tell apart: a
 * `200 text/html` means vite dropped the ping and infra-kit must ship a fix; a `502` means portless or a
 * proxy is shadowing the port; a `404` means a squatter won the free-port race. One glance, three very
 * different next moves — so the status and content-type travel with the verdict.
 */
export interface ForeignAnswer {
  kind: 'foreign'
  status: number
  contentType: string | null
}

/**
 * Three outcomes, not a boolean:
 * - `ok` — the endpoint PROVED it is serving (a 2xx on `/__health`; a 204 on vite's ping).
 * - `refused` — nothing answered (ECONNREFUSED, timeout, transport error).
 * - {@link ForeignAnswer} — something answered, but not the thing we asked for. For a backend that is a
 *   failure (our own fastify returning non-2xx). For a UI it is NOT: a non-204 is equally consistent with a
 *   squatter, with a proxy that shadows the ping, and with a future vite that dropped it — so it can never
 *   be allowed to paint red, and it is the reason this is not a boolean.
 */
export type ProbeOutcome = 'ok' | 'refused' | ForeignAnswer

/** Narrow a {@link ProbeOutcome} to the one arm that carries data. */
export const isForeign = (outcome: ProbeOutcome): outcome is ForeignAnswer => {
  return typeof outcome === 'object'
}

/** Build the `foreign` verdict from the response that earned it, draining its body so the socket returns. */
const foreignFrom = async (res: Response): Promise<ForeignAnswer> => {
  await res.body?.cancel()

  return { kind: 'foreign', status: res.status, contentType: res.headers.get('content-type') }
}

/**
 * The `◍ ?` warn. Names what answered instead of vite, because that is the whole actionable content: an
 * `html` body means vite dropped the ping (ours to fix), a 5xx means something is shadowing the port, a 404
 * means a squatter took it. The content-type is trimmed of its `; charset=…` tail — it is a hint, not a
 * header dump.
 */
const describeForeign = (port: number, answer: ForeignAnswer): string => {
  const type = answer.contentType?.split(';')[0]?.trim()
  const what = type == null || type === '' ? `${answer.status}` : `${answer.status} ${type}`

  return `port ${port} answered ${what}, not vite's ping — liveness cannot be verified`
}

/** Health-probe seam: resolve one target's liveness. Injectable so the panel stays deterministic in tests. */
export type HealthProbe = (target: ProbeTarget) => Promise<ProbeOutcome>

/** One budget for the whole probe — BOTH hops of a UI redirect share it (see {@link probeUi}). */
const PROBE_TIMEOUT_MS = 1500

/**
 * Vite's HMR ping. It is installed unconditionally on every dev server (no plugin, no config) and it sits
 * AHEAD of vite's `htmlFallback` middleware — which is the whole point: `htmlFallback` answers a plain
 * `GET /` with `200 index.html` even for a vite whose entry module throws, so a naive GET would report a
 * broken app as healthy. The ping cannot be forged that way; a 204 means a vite dev server is listening.
 */
const VITE_PING_HEADERS = { accept: 'text/x-vite-ping' } as const

/**
 * Where a target is probed. Always `http://127.0.0.1:<port>`, never the `https://<alias>` the panel prints:
 * the alias adds TLS, a private CA and the portless daemon to the path, so a probe through it would report
 * the PROXY's health, not the app's. And never `localhost` — ServerlessLocalRun binds v4 loopback only,
 * while `localhost` resolves `[::1]` first on modern Node, which renders a healthy backend `● down`.
 */
const probeUrl = (target: ProbeTarget): string => {
  return target.kind === 'api' ? `http://127.0.0.1:${target.port}/__health` : `http://127.0.0.1:${target.port}/`
}

/** `new URL(loc, base)`, or `null` when the header is unparseable even relative to the probe URL. */
const resolveHop = (location: string, base: string): URL | null => {
  try {
    return new URL(location, base)
  } catch {
    return null
  }
}

/** A backend: `/__health` must answer 2xx. Anything else IS our own fastify failing, so it is not `ok`. */
const probeApi = async (url: string, signal: AbortSignal): Promise<ProbeOutcome> => {
  const res = await fetch(url, { signal })

  if (!res.ok) return foreignFrom(res)
  // Drain: undici keeps the socket checked out until an unread body is GC'd, and this runs every 5s per app
  // for the life of the session.
  await res.body?.cancel()

  return 'ok'
}

/**
 * A frontend: vite's ping must answer 204.
 *
 * The redirect hop is the delicate part. Vite serves the ping from its `base`, so a UI configured with
 * `base: '/app/'` answers `/` with a 3xx whose `Location` is RELATIVE (`/app/`) — which is why the hop is
 * resolved against the probe URL rather than parsed on its own (`new URL('/app/')` throws outright). The
 * accept header is RE-SENT on the second hop: without it the redirected request falls through to vite's
 * html fallback and comes back `200 text/html` — the exact false green this probe exists to refuse.
 *
 * Exactly one hop, same-origin only. A cross-origin redirect is somebody else's server, and a second hop
 * is a loop we have no budget for; both report `foreign` — never followed, and never called alive.
 */
const probeUi = async (url: string, signal: AbortSignal): Promise<ProbeOutcome> => {
  const res = await fetch(url, { headers: VITE_PING_HEADERS, redirect: 'manual', signal })

  if (res.status === 204) return 'ok'
  if (res.status < 300 || res.status >= 400) return foreignFrom(res)

  const location = res.headers.get('location')
  const next = location == null ? null : resolveHop(location, url)

  if (next == null || next.origin !== new URL(url).origin) return foreignFrom(res)

  await res.body?.cancel()

  const hop = await fetch(next, { headers: VITE_PING_HEADERS, redirect: 'manual', signal })

  if (hop.status !== 204) return foreignFrom(hop)
  await hop.body?.cancel()

  return 'ok'
}

/** Default probe: per-kind, bounded, and loopback-only. A transport error or a timeout is `refused`. */
const defaultHealthProbe: HealthProbe = async (target: ProbeTarget): Promise<ProbeOutcome> => {
  const url = probeUrl(target)
  // ONE signal, shared across both hops: a redirect must not double the budget a wedged server can spend.
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)

  try {
    return target.kind === 'api' ? await probeApi(url, signal) : await probeUi(url, signal)
  } catch {
    return 'refused'
  }
}

/**
 * One row's probe history — the state the 5-arm {@link HealthState} is derived from, keyed by TAG (never
 * by app name: `foo/api` and `foo/ui` are different rows on the same app, and a name-keyed counter
 * collides them).
 */
interface HealthEntry {
  kind: ProbeTarget['kind']
  /** Consecutive `refused` probes. `>= LIVENESS_FAILURE_THRESHOLD` is what "down" MEANS. */
  failures: number
  /** Consecutive `foreign` probes — a separate counter, because a foreign answer must never go red. */
  foreignStreak: number
  /** Has this row EVER proved it was serving? Until it has, a UI is `starting`, not `down`. */
  everUp: boolean
  /** A CERTAINTY of death from outside the probe loop: a thrown restart, a dead UI engine. */
  dead: boolean
  /** The port answers, but not with what we asked for — liveness cannot be established either way. */
  unverified: boolean
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
  /**
   * Changed dist files a pending restart provably CANNOT pick up, keyed by the same debounce key the
   * restart is scheduled under (see {@link markChanged}).
   *
   * Accumulated rather than carried in the scheduled closure because {@link scheduleDebounced} REPLACES
   * the closure for a key it sees again, and one shared-lib save deliberately produces two events on the
   * same key: the package's own dist, then moments later the dependent app's. The package event is the
   * stale one and it arrives FIRST — a closure-carried flag would be overwritten by the app event and the
   * restart would print a green line for a reload that did not happen.
   */
  private pendingChanges: Map<string, Set<string>> = new Map()
  /**
   * Whole-graph ESM invalidation, when available. `null` means restarts re-import handler entries only
   * (the runtime lacks `module.registerHooks`, or `INFRA_KIT_DEV_NO_GENERATION=1` turned it off) — the
   * runner then falls back to classifying changes by entry-ness and still reports honestly.
   */
  private moduleGeneration: ModuleGenerationHandle | null = null
  /** Active chokidar watcher in `--watch` mode; closed on {@link shutdown}. */
  private watcher: FSWatcher | null = null
  private static readonly WATCH_DEBOUNCE_MS = 400
  /** Serialized restarts so rapid saves never bind :port while the previous server is still shutting down. */
  private restartWorkChain: Promise<void> = Promise.resolve()
  private static readonly PORT_RELEASE_DELAY_MS = 200
  /** Self-rescheduling backend liveness probe; cleared on {@link shutdown}. Null when unarmed (UI-only). */
  private livenessTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Probe history per row, keyed by TAG (`<app>/api`, `<app>/ui`) — never by app name, which would
   * collide an app's two halves into one counter the moment the frontends joined the tick. It survives an
   * ephemeral-port rebind on restart, because the tag does.
   */
  private readonly health = new Map<string, HealthEntry>()
  /** Tags whose first error has already been announced — the 0 → >0 edge fires once per row, not per tick. */
  private readonly firstErrorLogged = new Set<string>()
  /** `<ui-package>` → `<app>/ui` tag, so {@link uiTargets} can name the rows {@link uiPortMap} keys by package. */
  private readonly uiTagByPackage = new Map<string, string>()
  /** Liveness re-probe cadence. A wedged-but-not-crashed backend is caught within THRESHOLD ticks. */
  private static readonly LIVENESS_INTERVAL_MS = 5000
  /** Consecutive failures before a row is declared down — the anti-flap / restart-window filter. */
  private static readonly LIVENESS_FAILURE_THRESHOLD = 2
  /**
   * Refused probes a UI that has NEVER been up may take before its `◌ starting` turns `● down` (~30s at
   * the 5s cadence). Far above the backend threshold on purpose: a cold vite on a big frontend genuinely
   * takes tens of seconds to bind, and a red dot over a UI that is merely still booting is the one false
   * red this whole design refuses to ship. A UI that has been up once is not covered by it — its death is
   * probe-established at the ordinary threshold.
   */
  private static readonly NEVER_UP_DOWN_THRESHOLD = 6
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
   * The launched frontends and their declared `dev.proxy` routes, built once alongside {@link degradedRoutes}
   * from the SAME `loadDev` read the vite helper uses. Shared so both the degraded check and the ready
   * header's per-app proxy listing resolve off one source of truth.
   */
  private launchedUis: LaunchedUi[] = []
  /**
   * Every launched frontend route resolved to where it actually lands this run ({@link resolveProxyRoutes}),
   * for the nested "all proxies — which one and where" list under each UI row.
   *
   * A BOOT-TIME SNAPSHOT: computed once in {@link printReady} and only ever filtered (never re-derived) by
   * {@link proxiesFor}. It is committed into the static header, so under `--watch` a backend that boot-fails
   * then recovers keeps its `cloud` line here even after vite has flipped the live proxy back to `local`.
   * That live surface is deliberately owned by the self-clearing {@link degradedRows}, not this list.
   */
  private proxyRoutes: ResolvedProxyRoute[] = []
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
  /**
   * The single in-flight teardown, memoized by {@link shutdown} — `null` until the first caller arrives.
   *
   * Terminal death is ONE event observed through TWO channels: the kernel SIGHUPs the foreground process
   * group (`signal-shutdown.ts` handles it) and the next write trips the stdio `'error'` listener
   * (`terminal-liveness.ts`). Both fire, in either order. Without this memo the two callers would
   * `turboWatch.kill()`, `uiDev.kill()` and `server.close()` TWICE — a second SIGTERM→grace→SIGKILL cycle
   * aimed at a child group that is already mid-reap, which is the one way this fix could strand children
   * worse than the bug it repairs.
   */
  private teardown: Promise<void> | null = null
  /**
   * The teardown step currently in flight, for {@link shutdownStage}. Assigned before EVERY `await` in
   * {@link doShutdown}, because the whole value of the deadline in `signal-shutdown` is that it can NAME
   * the step that wedged — that is the instrument that answers why five orphaned processes never exited.
   */
  private stage = 'idle'

  constructor(
    options: DevServerOptions = {},
    runBuild: BuildRunner = launchScript,
    turboWatchFactory: TurboWatchFactory = defaultTurboWatchFactory,
    uiDevFactory: UiDevFactory = defaultUiDevFactory,
    dryRunner?: DryRunner,
    renderer?: DevUi,
    healthProbe: HealthProbe = defaultHealthProbe,
    proxy: PortlessDriver = createPortlessDriver(),
    sink?: DevLogSink,
  ) {
    this.options = options
    this.runBuild = runBuild
    this.turboWatchFactory = turboWatchFactory
    this.uiDevFactory = uiDevFactory
    this.dryRunner = dryRunner
    this.proxy = proxy
    // Injectable so a test can drive the REAL `reportFault` against a temp-dir sink and assert on the bytes
    // it actually files. Without the seam the fault-loop regression test can only hand-model the loop it is
    // supposed to be proving — and a hand-modelled loop goes green against the unfixed code.
    this.sink = sink ?? new DevLogSink()
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
        // Resolved alongside, never instead: which of the two wins is decided in `resolveRunPlan`,
        // once the number of apps this run launches is known. See {@link IApiAppConfig.appScopedPort}.
        appScopedPort: this.resolvePreferredPort(app.name, devConfig, false),
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
  private resolvePreferredPort(appName: string, devConfig: DevConfig, allowBarePort = true): number | undefined {
    return resolvePreferredPortPure(appName, process.env, devConfig, allowBarePort)
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

  /**
   * Refuse a preset whose target keys are not `<app>/api`|`<app>/ui` package identities BEFORE
   * {@link resolvePreset} runs — its {@link parseTargetKey} throws a raw error on a bare key (e.g.
   * `backoffice`), which would surface as an uncaught stack trace. {@link validatePresetKeys}
   * collects the same issues without throwing, so the run can refuse with a named, actionable message.
   */
  private assertPresetKeysValid(def: DevPreset): void {
    const name = this.options.preset ?? 'dev'
    const issues = validatePresetKeys({ [name]: def })

    if (issues.length === 0) {
      return
    }

    throw new Error(
      `infra-kit dev: cannot run this preset — ${issues
        .map((issue) => {
          return issue.message
        })
        .join('; ')}`,
    )
  }

  /**
   * Static locality pre-flight for a NAMED preset (`infra-kit dev <preset>`): refuse BEFORE any
   * server spawns when one of its `local` proxy pins names a backend the preset itself does not
   * launch. Shares the audit's context assembly ({@link buildPresetProxyContext}) so `infra-kit dev`
   * and `infra-kit audit` can never disagree about what "satisfiable" means.
   *
   * A config that fails to load is not refused here — the frontend is about to load the very same
   * file itself and will report it far better than this check can (mirrors the same call in
   * {@link collectDegradedRoutes}).
   */
  private async assertPresetProxyLocalityValid(
    name: string,
    def: DevPreset,
    discovered: DiscoveredParts,
    apiAppsAll: IApiAppConfig[],
  ): Promise<void> {
    const presets: DevPresets = { [name]: def }
    const { ctx, loadErrors } = await buildPresetProxyContext(this.monorepoRoot, presets, discovered, apiAppsAll)

    if (loadErrors.length > 0) {
      return
    }

    const issues = validatePresetProxy(presets, ctx)

    if (issues.length === 0) {
      return
    }

    throw new Error(
      `infra-kit dev: cannot run this preset — ${issues
        .map((issue) => {
          return issue.message
        })
        .join('; ')}`,
    )
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

    // Once per app, per run: `start()` runs exactly once per `DevServerRunner` instance, and `uiApps`
    // never has two entries for the same app, so a plain pass over it already satisfies "one-time".
    this.warnUiMissingVitePlugin(uiApps)

    // Before the first backend import, so every generation (including the first) is uniform.
    if (watch) this.installModuleGeneration()

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
    const devPresets = await this.loadDevPresets()
    const presetDef = this.resolvePresetDef(devPresets)

    // Guard BEFORE resolvePreset: its parseTargetKey throws a raw error on a key that isn't an
    // `<app>/api`|`<app>/ui` package (e.g. a bare `backoffice`), which surfaces as an uncaught stack
    // trace. Collect the same issues gracefully here and refuse with a human-readable, named message.
    this.assertPresetKeysValid(presetDef)

    const discovered: DiscoveredParts = {
      api: apiAppsAll.map((a) => {
        return a.name
      }),
      ui: uiAppsAll.map((a) => {
        return a.name
      }),
    }

    // Static proxy-locality pre-flight, scoped to the NAMED preset only (`infra-kit dev <preset>`):
    // a `presetDef` built in-memory (the wizard, or `--target`) is either already audited before
    // reaching here (wizard's `auditManualPlan`) or proxy-override-free (`--target` has no `.proxy`
    // field to pin), so re-checking it here would either double-refuse or check nothing. Complements,
    // never replaces, the RUNTIME pairing check below (`collectDegradedRoutes`): this one only sees
    // the preset's static declaration, before anything runs — it cannot catch a backend that WAS
    // launched but crashed, which is exactly what the runtime check is for.
    if (this.options.presetDef == null && this.options.preset != null) {
      await this.assertPresetProxyLocalityValid(this.options.preset, presetDef, discovered, apiAppsAll)
    }

    const resolved = resolvePreset(presetDef, discovered)

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
    // Split from the map below so the SURVIVOR COUNT is known before each app's port is chosen. The
    // choice cannot be made where the ports are resolved (`discoverApiApps`, over the full discovered
    // set): hulyo has 7 api apps, so a count taken there is never 1 even for `--app=client`.
    const selected = apiAppsAll.filter((a) => {
      return apiNames.has(a.name) && passesInclude(a.name)
    })
    const apps = selected.map((a) => {
      return {
        ...a,
        watchDeps: watchDepsByApp.get(a.name) ?? a.watchDeps,
        // One app → today's precedence exactly, bare `PORT` included. Two or more → the shared bare
        // `PORT` is dropped and each app falls to `dev.<app>.port` or an ephemeral bind, so a stray
        // `PORT` in the shell can no longer manufacture the conflict that refuses the whole run.
        preferredPort: selected.length === 1 ? a.preferredPort : a.appScopedPort,
      }
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

    // Stashed so the ready header's per-app proxy listing resolves off the exact same loaded routes the
    // degraded check does — one read, one source of truth, no chance of the two disagreeing.
    this.launchedUis = uis

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
   * Boot-time guard for a managed UI (see `DiscoveredUiApp.managedPort`) wired with the raw
   * `infraKitDev()` helper but not the `infraKit()` vite PLUGIN: only the plugin watches
   * `.infra-kit/dev-context` and restarts vite when the resolved proxy changes (see the
   * accepted-residual comment above this method's caller in {@link start}). A helper-only UI bakes
   * its proxy at config load, so a backend that recovers mid-session will not flip that UI's route
   * back to `local` until it is restarted by hand.
   *
   * No consumer is wired this way today — this is a guard against future wiring drift, not a fix for
   * a live bug. Logged through the same `warn`-level path every other boot warning uses (e.g. the
   * unmatched-preset-targets line in {@link resolveRunPlan}), so it is MCP/JSON-safe for free.
   */
  private warnUiMissingVitePlugin(uiApps: DiscoveredUiApp[]): void {
    for (const ui of uiApps) {
      if (!ui.managedPort || usesInfraKitVitePlugin(ui.path)) continue

      this.renderer.log(
        `⚠️  ${ui.name}/ui is wired with the infra-kit vite helper directly, not the infraKit() plugin — ` +
          `its proxy is baked at config load and won't react to backend routing changes. Wire the ` +
          `infraKit() vite plugin (from @slip-stream-kit/vite) instead.`,
        'warn',
      )
    }
  }

  /**
   * The resolved proxy rows for one frontend, for its nested "which proxy, and where" list — or undefined
   * when it declares none, so a frontend with no `dev.proxy` block adds no empty group to the header.
   */
  private proxiesFor(app: string): ProxyRouteRow[] | undefined {
    const rows = this.proxyRoutes
      .filter((p) => {
        return p.uiApp === app
      })
      .map((p): ProxyRouteRow => {
        return { route: p.route, source: p.source, target: p.target }
      })

    return rows.length > 0 ? rows : undefined
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
        this.markUiEngineDead()
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
   * The failure is classified rather than reported with one generic message, because "not serving" has three
   * unrelated causes with three different fixes: portless was never installed as a dependency at all, its
   * one-time OS service was never registered, its OS service IS registered but the daemon it starts is
   * currently down (crashed/stopped), or something ELSE is squatting on the port and installing/trusting
   * portless would not free it.
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

    const outcome = await this.proxy.probeProxy(this.proxyPort, true)

    if (outcome === 'serving') return

    if (outcome === 'not-portless') {
      throw new Error(
        `infra-kit dev: something else is already listening on :${this.proxyPort}, and it is not portless ` +
          `(no \`X-Portless\` header on the wire). Find and stop it, e.g. \`sudo lsof -iTCP:${this.proxyPort} -sTCP:LISTEN\`. ` +
          'Installing or trusting portless will not help while another process holds the port.',
      )
    }

    // outcome === 'daemon-down': nothing is even accepting TCP. Whether that means "never installed" or
    // "installed, but currently not running" changes the fix, so it is split on the OS-service check —
    // `'unknown'` (an uncovered platform) falls through to the "installed but down" branch rather than
    // guessing `'no'`, since a wrong guess there would send an already-provisioned machine back through a
    // root install for nothing.
    if (this.proxy.isServiceInstalled() === 'no') {
      throw new Error(
        `infra-kit dev: no portless daemon is serving HTTPS on :${this.proxyPort}, and its OS service is not ` +
          'installed yet, so no dev URL can resolve. Install it once (this is the only step that needs root):\n' +
          `    ${formatPortlessCommand(['service', 'install'], { sudo: true, bin })}\n` +
          'Then trust its local CA (no sudo needed):\n' +
          `    ${formatPortlessCommand(['trust'], { bin })}\n` +
          '`infra-kit doctor` checks both.',
      )
    }

    throw new Error(
      `infra-kit dev: portless's OS service is installed, but no daemon is currently serving HTTPS on ` +
        `:${this.proxyPort} — it may have crashed or been stopped, so no dev URL can resolve. Check its state:\n` +
        `    ${formatPortlessCommand(['service', 'status'], { bin })}\n` +
        'Reinstalling restarts it (still the only step that needs root):\n' +
        `    ${formatPortlessCommand(['service', 'install'], { sudo: true, bin })}\n` +
        '`infra-kit doctor` checks the daemon and CA trust state.',
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
  private restart(apps: IApiAppConfig[], staleFiles: string[] = []): Promise<void> {
    if (this.shuttingDown) return Promise.resolve()

    return this.scheduleRestartWork(() => {
      // Re-checked inside the chain: this job may have queued behind a restart that was still
      // running when shutdown() latched, so the flag can flip between scheduling and execution.
      if (this.shuttingDown) return Promise.resolve()

      return this.runRestart(apps, staleFiles)
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
    const tag = `${app.name}/api`

    // Seed the health entry BEFORE the app is visible in `appServers`, not after the probe the caller takes
    // a few lines later. The liveness tick can fire in that window, and {@link healthOf} treats an ABSENT
    // entry as `unknown` — a row with no dot at all for a server that is already serving. A fresh entry is
    // the honest prior instead: never-up, which for a backend reads `● down` until a probe says otherwise.
    this.healthEntry(tag, 'api')
    this.appServers.push(entry)

    const failedIdx = this.failedApps.findIndex((f) => {
      return f.app.name === app.name
    })

    if (failedIdx >= 0) this.failedApps.splice(failedIdx, 1)

    if (this.lastSummary) {
      this.lastSummary = {
        ...this.lastSummary,
        endpoints: [
          ...this.lastSummary.endpoints,
          {
            tag,
            url: resolveEndpointUrl({ prefixUrl: app.prefixUrl, alias: started.alias }),
            // NOT `ok`. This app has bound a port; nothing has probed it. A server that binds and then 500s
            // on `/__health` would be painted green here on the strength of having started — the same
            // unearned claim the `● failed` row exists to prevent. The caller probes right after and
            // {@link refreshStatus} paints the answer.
            health: this.healthOf(tag),
          },
        ],
        failed: (this.lastSummary.failed ?? []).filter((f) => {
          return f.tag !== tag
        }),
      }
    }

    return entry
  }

  private async runRestart(apps: IApiAppConfig[], staleFiles: string[] = []): Promise<void> {
    const targets = this.resolveRestartTargets(apps)

    if (targets.length === 0) return

    const label = targets.length === 1 ? targets[0]!.app.name : `${targets.length} apps`

    // Judge process size BEFORE the generation is bumped, and abort the whole restart on `'stop'`.
    //
    // The ORDER is the fix, not a detail. `bump()` clears `busted`, and `resolveStaleFiles` reads that
    // set to decide whether the restart actually picked the change up. A refusal that happened after a
    // bump would leave the previous generation's set in place, `resolveStaleFiles` would find the
    // changed file's directory in it, and the runner would print a green `Restarted` over code that was
    // never re-imported. Returning here means no bump, no `server.close()`, no re-import: the process
    // keeps serving its current, correct modules right up to teardown.
    const budget = this.moduleGeneration?.budgetState() ?? 'ok'

    if (budget === 'stop') {
      this.reportGenerationBudgetStop(resolveStopBudget(process.env.INFRA_KIT_DEV_STOP_BYTES).stopBytes)
      // The runner cannot exit itself: `doShutdown` stops every child and unmounts Ink but contains no
      // `process.exit`, and this path reaches neither the signal handler nor the fatal one. Without the
      // request the user is left at a live terminal with nothing running. `.finally` so a REJECTING
      // teardown still exits; the trailing `.catch` because `onExitRequest` runs inside it and a throw
      // there would reject into the crash barrier on the one path meant to end the process cleanly.
      void this.shutdown()
        .catch(() => {})
        .finally(() => {
          this.options.onExitRequest?.(1)
        })
        .catch(() => {})

      return
    }

    if (budget === 'warn') this.reportGenerationBudgetWarn()

    // Start a new generation BEFORE anything re-imports: every local module the restart touches now
    // resolves to a fresh URL, so the whole graph re-evaluates rather than just the handler entries.
    this.moduleGeneration?.bump()

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
        const tag = `${app.name}/api`

        // A restart that THREW never bound a port — there is nothing to probe, and nothing to be flap-shy
        // about. Routed through {@link markDown}, not the probe path, because the soft path would leave the
        // row one failure short of the threshold, i.e. GREEN, for a server that does not exist.
        if (entry == null) {
          this.markDown(tag, 'api')
          this.refreshStatus()

          return { label: `${app.name} ● down`, healthy: false }
        }

        // Through the SAME state machine as every tick, so the panel's dot and this line report the same
        // probe. They used to be two verdicts computed from one result, and they could disagree.
        const target: ProbeTarget = { tag, port: entry.boundPort, kind: 'api' }
        const outcome = await this.healthProbe(target)

        this.recordProbe(target, outcome)
        this.refreshStatus()

        const healthy = outcome === 'ok'

        return { label: `${app.name}:${entry.boundPort} ${healthy ? '● up' : '● down'}`, healthy }
      }),
    )

    const allHealthy = probed.every((p) => {
      return p.healthy
    })
    const labels = probed
      .map((p) => {
        return p.label
      })
      .join(', ')

    // Did the restart actually load the changed code? With the generation hook installed this is a
    // DIRECT observation — the hook records every path it re-resolved, so a changed file whose directory
    // never appears is provably still being served from the old module. Without the hook it falls back
    // to entry-ness, which is the narrower contract that mode really offers.
    //
    // A restart where nothing came back up is skipped: `❌ Failed to restart` already said the true
    // thing, and adding "still serving the OLD" on top would describe a server that is not serving.
    const anyRestarted = outcomes.some((o) => {
      return o.entry !== null
    })
    const stale = anyRestarted ? this.resolveStaleFiles(staleFiles, targets) : []

    // NOT `✅ Restarted`. The fastify server really was replaced — but the changed module was not
    // re-evaluated, so Node's registry still holds the version first loaded and this app is serving the
    // OLD code. Claiming success here is what sent people hunting for "where that stale copy is loaded
    // from" instead of just re-running the server.
    if (stale.length > 0) {
      this.renderer.log(
        `⚠️  Restarted ${labels} — still serving the OLD ${describeStaleFiles(stale)}. ` +
          'Re-run `infra-kit dev` to pick this up.',
        'warn',
      )

      return
    }

    this.renderer.log(`${allHealthy ? '✅' : '⚠️ '} Restarted ${labels}`)
  }

  /**
   * Of the files this restart was triggered by, which is the running process still serving from its old
   * module? Two modes, and the difference is what the runner is allowed to claim:
   *
   * - **Generation hook installed** — a direct observation. The hook recorded every path it re-resolved
   *   for this generation, so a changed file whose directory is absent was genuinely not re-evaluated.
   *   This is what catches the hook silently doing nothing (a mis-anchored root, a passed cap): the
   *   busted set is empty, every changed file reports stale, and the runner says so instead of ✅.
   * - **No hook** — fall back to entry-ness, the narrower contract that mode actually offers.
   */
  private resolveStaleFiles(changed: string[], targets: Array<{ app: IApiAppConfig }>): string[] {
    const generation = this.moduleGeneration

    if (generation) {
      return changed.filter((file) => {
        return !generation.bustedUnder(path.dirname(file))
      })
    }

    return changed.filter((file) => {
      return !targets.some((t) => {
        return isHotReloadableChange(file, t.app.path)
      })
    })
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
   * Report a persistent engine (`turbo watch build` / `turbo run dev`) that died on its OWN as a single
   * warn line, unless teardown is already underway. Centralises the `shuttingDown` guard and the message
   * shape shared by both engine callbacks — `superviseChild`'s `killing` latch already suppresses the
   * exit our own `kill()` causes, so this only ever fires on a genuine crash.
   */
  private reportEngineDeath(engine: string, consequence: string, detail: string): void {
    if (this.shuttingDown) return
    this.renderer.log(`⚠️  ${engine} ${detail} — ${consequence}. Restart \`infra-kit dev\`.`, 'warn')
  }

  /**
   * The `turbo run dev` engine died on its own, so a UI that was NEVER up is never coming up — its vite
   * either never bound or went down with the engine, and no further probe is going to tell us anything the
   * engine's corpse has not already said. Recorded as `dead`, which {@link neverUpState} reads ONLY in the
   * never-up branch: a UI that HAS been up keeps its ordinary probe-established death, because turbo does
   * not kill its task process groups and our reap is best-effort — an orphaned vite may well still be
   * serving, and it would be a live, hot-reloading UI we had just painted red.
   */
  private markUiEngineDead(): void {
    if (this.shuttingDown) return

    for (const { tag, kind } of this.uiTargets()) {
      this.healthEntry(tag, kind).dead = true
    }
    this.refreshStatus()
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

    // `change` alone is blind to a module that is NEW or REMOVED — chokidar files those under `add`
    // and `unlink`. So a helper added to a shared package, or a file deleted from one, produced no
    // restart at all: the running process kept serving a graph that no longer matches the source.
    //
    // Subscribing to all three cannot storm. `ignoreInitial: true` above drops the startup
    // enumeration; a rebuild that rewrites existing output still emits `change`, not `add`; and
    // {@link scheduleDebounced} collapses a burst onto one timer per key. `unlink` is safe to route
    // through the same classifier because {@link classifyDistChange} is pure path arithmetic — it
    // never stats the file, so a path that has just stopped existing classifies exactly as it did.
    for (const event of ['add', 'change', 'unlink'] as const) {
      watcher.on(event, (filePath: string) => {
        this.handleDistChange(filePath, apps, appDistDirs, packageDistDirs)
      })
    }

    this.renderer.narrate(
      `👀 Watching ${appDistDirs.length} app dist + ${packageDistDirs.length} package dist dir(s) for changes...`,
    )
    // State the reload contract up front rather than letting each restart imply one. Which contract is
    // in force depends on whether whole-graph invalidation is installed, so the banner reports what this
    // session can actually do — and either way a restart that misses a change says so explicitly.
    this.renderer.narrate(
      this.moduleGeneration
        ? '👀 Watch reloads the whole local graph in place — shared packages and services included.'
        : '👀 Watch reloads serverless handler entry files only; other modules need a re-run of `infra-kit dev`.',
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
      this.handlePackageDistChange(filePath, apps, change.packageDir)

      return
    }

    const app = apps.find((a) => {
      return path.join(a.path, 'dist') === change.app
    })

    if (!app) return

    // Every change is recorded, not just the ones a restart is expected to miss: whether it was really
    // picked up is decided AFTER the restart, from what the generation hook actually re-resolved.
    this.markChanged(app.name, filePath)

    this.scheduleDebounced(app.name, () => {
      return this.restart([app], this.takeChanged(app.name))
    })
  }

  /**
   * Route a shared-package dist change to the backends that depend on it. A package file is NEVER a
   * handler entry, so every restart it triggers is marked stale — the rebuilt package is not what the
   * running process will serve.
   */
  private handlePackageDistChange(filePath: string, apps: IApiAppConfig[], packageDir: string | undefined): void {
    // Read late: the map may still be building (→ `null` → restart all), which is correct, just unscoped.
    const targets = selectPackageRestartTargets(apps, this.closureMap, packageDir)

    if (targets === null) {
      // Fail-safe: no closure map / no package identity → restart every launched app. Note this
      // ignores per-app `watchDeps: false` opt-outs — opt-out is best-effort and yields to the
      // fail-safe superset, so a `turbo --dry` failure never silently drops a needed restart.
      this.markChanged('__packages__', filePath)
      this.scheduleDebounced('__packages__', () => {
        return this.restart(apps, this.takeChanged('__packages__'))
      })

      return
    }

    // Empty target set = the package is UI-only or every dependent opted out → no restart.
    //
    // Keyed per TARGET APP, not per package dir. `turbo watch build`'s dep-inclusive rebuild cascades a
    // shared-lib edit into the package's own dist AND, moments later, its dependent app's dist — two
    // chokidar `change` events for one save, this branch for the first and the app-dist branch above
    // for the second. A package-dir key and an app-name key are two different `watchDebounceTimers`
    // entries, so both timers used to elapse independently and fire `restart()` twice for the same app.
    // Scheduling by app name here collapses both events onto the SAME entry — `scheduleDebounced`
    // already cancels a pending timer for a key it sees again — so the app restarts once per burst.
    for (const target of targets) {
      this.markChanged(target.name, filePath)
      this.scheduleDebounced(target.name, () => {
        return this.restart([target], this.takeChanged(target.name))
      })
    }
  }

  /** Record a file the pending restart under `key` was triggered by. See {@link pendingChanges}. */
  private markChanged(key: string, filePath: string): void {
    const existing = this.pendingChanges.get(key)

    if (existing) existing.add(filePath)
    else this.pendingChanges.set(key, new Set([filePath]))
  }

  /**
   * Install whole-graph ESM invalidation so a restart re-evaluates shared packages and service modules,
   * not just handler entries. Best-effort by design: an unavailable runtime, or the explicit
   * `INFRA_KIT_DEV_NO_GENERATION=1` opt-out, leaves `moduleGeneration` null and the runner reports the
   * narrower reload contract instead of pretending to the wider one.
   */
  private installModuleGeneration(): void {
    if (process.env.INFRA_KIT_DEV_NO_GENERATION === '1') {
      this.renderer.log('👀 Module generation disabled (INFRA_KIT_DEV_NO_GENERATION=1)', 'debug')

      return
    }

    if (!isModuleGenerationSupported()) {
      this.renderer.log(
        `⚠️  This Node (${process.version}) has no \`module.registerHooks\`, so only handler entry files reload in place.`,
        'warn',
      )

      return
    }

    const budget = resolveStopBudget(process.env.INFRA_KIT_DEV_STOP_BYTES)

    this.moduleGeneration = installGenerationHook({
      // The runner's OWN root, realpath'd — the same value the dist watcher is anchored on. A main-repo
      // root would collapse a linked worktree and make the hook a silent no-op for the whole session.
      root: fs.realpathSync(this.monorepoRoot),
      selfDist: selfDistDir(),
      stopBytes: budget.stopBytes,
      stopEnabled: budget.stopEnabled,
    })
  }

  /**
   * Notice on the way up, at half the budget and again every stride beyond it.
   *
   * The observed size is IN the line, which is what makes this the measurement as well as the warning:
   * a session reports its own footprint on a real repo, current, for free — the number an offline study
   * would have gone looking for and would have had to re-take after every dependency change.
   */
  private reportGenerationBudgetWarn(): void {
    const generation = this.moduleGeneration?.generation() ?? 0

    this.renderer.log(
      `⚠️  Reload memory ${megabytes(process.memoryUsage.rss())} after ${generation} reload(s). Module ` +
        'records cannot be freed in-process, so this only grows — re-run `infra-kit dev` when convenient.',
      'warn',
    )
  }

  /**
   * The budget is spent, and this time the session really does stop.
   *
   * It stops rather than quietly ceasing to invalidate, because a hook that stopped busting would put
   * the session back on stale code under a green line — the precise failure `resolveStaleFiles` exists
   * to make impossible. The message names the observed size, the threshold, the env var that raises or
   * disables the budget, and the command to start again.
   */
  private reportGenerationBudgetStop(stopBytes: number): void {
    const generation = this.moduleGeneration?.generation() ?? 0

    this.renderer.log(
      `⛔ Reload memory ${megabytes(process.memoryUsage.rss())} exceeds the ${megabytes(stopBytes)} budget ` +
        `after ${generation} reload(s) — stopping. Module records cannot be freed in-process. Re-run ` +
        '`infra-kit dev` to continue, or set INFRA_KIT_DEV_STOP_BYTES to raise the budget (or `off` to ' +
        'disable the stop).',
      'error',
    )
  }

  /** Drain the stale files recorded for `key` — read at FIRE time, so the whole burst is accounted for. */
  private takeChanged(key: string): string[] {
    const files = this.pendingChanges.get(key)

    this.pendingChanges.delete(key)

    return files ? [...files] : []
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

  /** Is the frontend health probe on? `--no-ui-health` / `INFRA_KIT_NO_UI_HEALTH=1` turn it off. */
  private uiHealthEnabled(): boolean {
    return (this.options.uiHealth ?? true) && process.env.INFRA_KIT_NO_UI_HEALTH !== '1'
  }

  /** Every running backend, as probe targets. The CURRENT `boundPort` is read fresh — a restart rebinds it. */
  private apiTargets(): ProbeTarget[] {
    return this.appServers.map(({ app, boundPort }) => {
      return { tag: `${app.name}/api`, port: boundPort, kind: 'api' as const }
    })
  }

  /**
   * Every MANAGED frontend, as probe targets — derived from {@link uiPortMap}, which is exactly the set of
   * UIs whose port this runner assigned. A UI that fell back to a reference line has no port we own, so
   * there is nothing to probe and its row stays `unknown` (no dot), which is the honest answer. Empty when
   * UI health is off, which is the whole implementation of `--no-ui-health`: no targets, no probes, no dots.
   */
  private uiTargets(): ProbeTarget[] {
    if (!this.uiHealthEnabled()) return []

    return Object.entries(this.uiPortMap).map(([pkg, { port }]) => {
      return { tag: this.uiTagByPackage.get(pkg) ?? `${pkg}/ui`, port, kind: 'ui' as const }
    })
  }

  /** This tag's entry, created on first sight. */
  private healthEntry(tag: string, kind: ProbeTarget['kind']): HealthEntry {
    const existing = this.health.get(tag)

    if (existing) return existing

    const fresh: HealthEntry = { kind, failures: 0, foreignStreak: 0, everUp: false, dead: false, unverified: false }

    this.health.set(tag, fresh)

    return fresh
  }

  /**
   * Fold one probe outcome into a row's history and fire the edge logs — each exactly once, so a steady
   * state (healthy OR wedged) says nothing.
   *
   * The `foreign` arms are where the two kinds part company. A backend answering non-2xx is OUR fastify
   * failing, so it counts as a failure like any other. A UI answering something that is not vite's ping is
   * unverifiable — a squatter, a proxy shadowing the ping, a future vite that dropped it — so it counts
   * toward nothing and only raises `unverified`, which renders `◍ ?` and never red.
   */
  private recordProbe(target: ProbeTarget, outcome: ProbeOutcome): void {
    const entry = this.healthEntry(target.tag, target.kind)
    const threshold = DevServerRunner.LIVENESS_FAILURE_THRESHOLD

    if (outcome === 'ok') {
      const wasDown = entry.failures >= threshold

      entry.everUp = true
      entry.failures = 0
      entry.foreignStreak = 0
      entry.unverified = false
      if (wasDown) this.renderer.log(`✅ ${target.tag} recovered`)

      return
    }

    if (isForeign(outcome) && target.kind === 'ui') {
      entry.foreignStreak += 1
      entry.unverified = entry.foreignStreak >= threshold
      if (entry.foreignStreak === threshold) {
        this.renderer.log(`⚠️  ${target.tag}: ${describeForeign(target.port, outcome)}`, 'warn')
      }

      return
    }

    entry.foreignStreak = 0
    entry.failures += 1
    // A port that answers SOMETHING is not provably dead — so a UI drops `unverified` only once its refusals
    // have earned a real `down`, and never on the way there.
    if (target.kind === 'ui' && entry.failures >= threshold) entry.unverified = false
    if (entry.failures === threshold) {
      const why = target.kind === 'api' ? '/__health not responding' : "not answering vite's ping"

      this.renderer.log(`⚠️  ${target.tag} unhealthy (${why})`, 'warn')
    }
  }

  /**
   * Declare a row down WITHOUT a probe — for the two facts the probe loop cannot establish: a restart whose
   * `startOneApp` threw (there is no server left to probe), and a UI whose engine died before it was ever
   * up. Routing those through the soft probe path would leave the row one failure short of the threshold,
   * i.e. GREEN, for something that demonstrably does not exist.
   */
  private markDown(tag: string, kind: ProbeTarget['kind']): void {
    const entry = this.healthEntry(tag, kind)

    entry.dead = true
    entry.failures = DevServerRunner.LIVENESS_FAILURE_THRESHOLD
    entry.foreignStreak = 0
    entry.unverified = false
  }

  /** The 5-arm row state for a tag. No entry at all → `unknown` (a `UiRef`, or `--no-ui-health`). */
  private healthOf(tag: string): HealthState {
    const entry = this.health.get(tag)

    if (entry == null) return 'unknown'
    if (entry.unverified) return 'unverified'
    if (!entry.everUp) return this.neverUpState(entry)

    return entry.failures >= DevServerRunner.LIVENESS_FAILURE_THRESHOLD ? 'down' : 'ok'
  }

  /**
   * A row that has never proved it was serving. A backend is `down` on sight — it is started in-process and
   * probed the moment it binds, so "up but never answered" is already a failure. A UI is `starting` until it
   * has burned the whole never-up budget: vite is spawned AFTER the ready frame and takes real seconds to
   * bind, and a red dot over a UI that is merely still booting is the one false red this design refuses.
   *
   * `dead` is read HERE and nowhere else, and the narrowness is the point: an `everUp` UI's death must stay
   * probe-established. Turbo puts each task in its OWN process group and reaps none of them on death
   * (`managed-child.ts`), and our own reap is best-effort — so "the engine exited ⇒ every vite is dead" is
   * simply false, and believing it would red-dot a live, hot-reloading UI.
   */
  private neverUpState(entry: HealthEntry): HealthState {
    if (entry.kind === 'api' || entry.dead) return 'down'

    return entry.failures >= DevServerRunner.NEVER_UP_DOWN_THRESHOLD ? 'down' : 'starting'
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
   * One liveness sweep over every running backend AND every managed frontend. Edge-triggered per ROW,
   * keyed by tag (so the counter survives an ephemeral-port rebind on restart) with the CURRENT port read
   * fresh each tick. The verdict rules live in {@link recordProbe}; the threshold is what makes a normal
   * watch-restart (server down <1s, a single interval) invisible — only a genuinely wedged app stays down
   * across two sweeps.
   *
   * `/__health` probes are already filtered out of the live request tail ({@link startOneApp}'s
   * `onRequestLog`), and vite's ping is not a line vite logs, so this never spams. Bails once teardown has
   * latched so a closing server is not misread as down (the timer is also cleared in {@link shutdown}
   * before the servers close).
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
        return { ...ref, errors: this.announceFirstError(ref.tag) }
      }),
      endpoints: summary.endpoints.map((endpoint) => {
        const server = byTag.get(endpoint.tag)

        return {
          ...endpoint,
          // Every row's health comes from the ONE probe state machine now — a UI row's included. A row
          // nothing probes (a `UiRef`, or `--no-ui-health`) has no entry and resolves to `unknown`, which
          // renders no dot at all: exactly what it used to hardcode.
          health: this.healthOf(endpoint.tag),
          // A UI row has no backend server, so it has no uptime, no restarts and no request rate — but it
          // DOES have an error count, which is the whole reason the panel can report a broken frontend.
          uptimeMs: server ? now - server.startedAt : undefined,
          restarts: server?.restarts,
          rpm: (this.reqTimes.get(endpoint.tag) ?? []).length,
          errors: this.announceFirstError(endpoint.tag),
        }
      }),
    })
  }

  /**
   * This row's error count, announcing the 0 → >0 EDGE once with a terminal line.
   *
   * The counter alone is not enough, and the reason is the honest cost of a liveness dot: a frontend that
   * fails to compile still serves and still answers vite's ping, so its dot stays a truthful green while
   * the app is unusable. `⚠ N` is then the only thing on screen that disagrees — and a number quietly
   * ticking up in a panel corner is not a thing anyone notices. The edge log is; it also reaches a non-TTY
   * run, which has no panel at all.
   */
  private announceFirstError(tag: string): number {
    const { errors } = this.sink.statsFor(tag)

    if (errors > 0 && !this.firstErrorLogged.has(tag)) {
      this.firstErrorLogged.add(tag)
      this.renderer.log(`⚠️  ${tag} reported its first error → ${homeShorten(this.sink.pathFor(tag))}`, 'warn')
    }

    return errors
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
      [...this.apiTargets(), ...this.uiTargets()].map((target) => {
        return this.probeOne(target)
      }),
    )

    // The panel's heartbeat. It rides the probe tick that already exists rather than adding a timer of
    // its own, so the numbers on screen are exactly as fresh as the health behind them.
    this.refreshStatus()
  }

  /** Probe one target and fold the outcome in. Split out of {@link livenessTick} to keep both simple. */
  private async probeOne(target: ProbeTarget): Promise<void> {
    const outcome = await this.healthProbe(target)

    // Re-check AFTER the await: shutdown() may have latched and begun closing servers while this probe was
    // in flight, resolving it `refused` against a closing socket. Without this a tick that passed the
    // top-of-method bail could log a false `unhealthy` during teardown.
    if (this.shuttingDown) return

    this.recordProbe(target, outcome)
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

    // The boot probe goes through the SAME state machine as every tick — it is not a separate verdict that
    // the panel then forgets. It used to be: `printReady` probed, painted the dot from the local result,
    // and left the failure counter empty — so the `refreshStatus()` at the bottom of this method, reading
    // that empty map, painted a backend probed DOWN one line ago a confident green, and kept it green until
    // the first tick. The boot frame and the panel under it disagreed about a probe taken once.
    await Promise.all(
      this.apiTargets().map((target) => {
        return this.probeOne(target)
      }),
    )

    const endpoints: EndpointRow[] = this.appServers.map(({ app, alias }) => {
      return {
        tag: `${app.name}/api`,
        url: resolveEndpointUrl({ prefixUrl: app.prefixUrl, alias }),
        health: this.healthOf(`${app.name}/api`),
      }
    })

    // Pre-assign each UI a free port + its portless alias and stash the map for startUiDev's env. Owning
    // the port is what makes the UI's URL knowable before vite prints it, so every UI gets a real endpoint
    // row. Only a UI whose port could not be assigned falls back to a reference line ("vite prints its URL
    // below") — and, having no port we own, no health dot either.
    // Resolve every launched frontend's routes to where they actually land, so each UI row can carry its
    // own "which proxy, and where" list. Built from the SAME loaded routes the degraded check used plus the
    // live running set + backend origins here, so the listing matches the proxy vite really serves.
    const originByPkg = new Map(
      this.appServers.map(({ app, alias }) => {
        return [app.packageName, resolveEndpointUrl({ prefixUrl: app.prefixUrl, alias })] as const
      }),
    )

    this.proxyRoutes = resolveProxyRoutes({
      uis: this.launchedUis,
      running: new Set(
        this.appServers.map(({ app }) => {
          return app.packageName
        }),
      ),
      localOrigin: (pkg) => {
        return originByPkg.get(pkg)
      },
      env: process.env[INFRA_KIT_ENV_VAR],
    })

    this.uiPortMap = {}
    const uiEndpoints: EndpointRow[] = []
    const uiRefs: UiRef[] = []

    for (const ui of uiApps) {
      const assigned = await this.assignUiPort(ui)
      const tag = `${ui.name}/ui`

      if (assigned != null) {
        uiEndpoints.push({
          tag,
          url: resolveEndpointUrl({ prefixUrl: '', alias: assigned.alias }),
          health: this.seedUiHealth(tag),
          proxies: this.proxiesFor(ui.name),
        })
      } else {
        uiRefs.push({ tag, proxies: this.proxiesFor(ui.name) })
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
    // `uiPortMap` is keyed by PACKAGE because that is the key the vite child reads it back by
    // (`INFRA_KIT_UI_PORTS`) — the rows are keyed by app. Record the mapping rather than widening the
    // fragment: it is a published wire contract with a separately-versioned helper.
    this.uiTagByPackage.set(ui.packageName, `${ui.name}/ui`)

    return { port, alias }
  }

  /**
   * Seed a managed UI's row so it reads `◌ starting` from the boot frame onward.
   *
   * Vite is spawned AFTER `printReady` — the first probe is a whole tick away — so an unseeded row would
   * carry no dot at all until then, and a row that is `● down` at boot would be a lie about a server that
   * has not been asked a single question yet. `unknown` when UI health is off: no entry, no dot, ever.
   */
  private seedUiHealth(tag: string): HealthState {
    if (!this.uiHealthEnabled()) return 'unknown'

    this.healthEntry(tag, 'ui')

    return this.healthOf(tag)
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

    // `shuttingDown` latches at the very TOP of `doShutdown`, before the renderer is disposed a few lines
    // later — so a fault landing anywhere from that point on (a rejection out of `watcher.close()`,
    // `turboWatch.kill()`, `uiDev.kill()`, all unguarded) must never reach `renderer.log` below and call
    // back into a torn-down panel. Orderly shutdown already owns the process's fate at that point; the
    // file write above is enough, and disarming the crash barrier itself (see `crash-barrier.ts`'s
    // `disarm()`) is what keeps a fault from reaching this method at all on the fatal-exit path.
    if (this.shuttingDown) return

    // Print it through the UI, NOT through the bypass. `rawStdoutWrite` would push N raw lines onto a
    // terminal whose live region Ink believes it owns: Ink erases by counting rows back from where it
    // thinks the cursor is, so the very next repaint (≤5s away, on the liveness tick) would erase the
    // tail of this stack and leave a ghost of the old panel above it. The method exists to make a fault
    // impossible to miss; writing it somewhere the next frame deletes it is worse than not writing it.
    //
    // `renderer.log` commits through Ink's `<Static>` region, which survives every repaint — and falls
    // through to a plain stdout write on the non-TTY renderer, where there is no region to respect.
    //
    // `tee: false` because the line above ALREADY filed it. Left teeing, the renderer files a second copy
    // through `appendRunnerLog` — every fault landing twice in `runner.log`, a literal 2× on the 185 GB the
    // storm wrote. The direct `sink.write` is the copy that must survive: it is the one that carries the
    // `error` level, and the level is what turns the panel row red.
    this.renderer.log(detail, 'error', { tee: false })
  }

  /**
   * File a fault into the log WITHOUT touching the terminal.
   *
   * The channel of last resort: when stdio is unwritable, printing is what produces the fault, so the sink
   * is the only surface a post-mortem can still read. Used by the entry's fatal path.
   */
  public fileFault(detail: string): void {
    this.sink.write(currentService() ?? RUNNER_SERVICE, detail, { level: 'error' })
  }

  /**
   * The teardown step currently in flight (`'idle'` before {@link shutdown}, `'done'` after it completes).
   *
   * Read by the entry's `describeStall` seam when the teardown deadline trips, so the force-quit line names
   * WHICH step wedged rather than shrugging. Without it the deadline is just a force-quit, and the question
   * the incident actually poses — why five processes that demonstrably ran `shutdown()` never exited — stays
   * open after shipping the thing meant to answer it.
   */
  public get shutdownStage(): string {
    return this.stage
  }

  /**
   * Stop watching, cancel any pending debounced restart, and close all running servers. Idempotent: every
   * caller after the first gets the SAME in-flight promise, never a second teardown.
   *
   * The `.catch` is attached HERE, at assignment, in the same tick — not by the caller. `doShutdown` can
   * reject (`watcher.close()`, `turboWatch.kill()`, `uiDev.kill()` are unguarded), and the fatal path calls
   * this fire-and-forget while a deadline races it. A rejection with no handler attached in the assigning
   * tick fires `unhandledRejection` → the crash barrier → and, since stdio is dead on that path, straight
   * back into the fatal handler: the exact loop this whole change exists to remove, re-created inside its
   * own fix. Callers that DO await still see the rejection — this handler only disarms the process-level
   * channel.
   */
  public shutdown(): Promise<void> {
    if (this.teardown != null) return this.teardown

    this.teardown = this.doShutdown()
    this.teardown.catch(() => {})

    return this.teardown
  }

  private async doShutdown(): Promise<void> {
    // Latch BEFORE anything else. Everything below assumes no new alias can be registered once
    // teardown begins; `scheduleDebounced` and `restart` read this flag to honour that.
    this.shuttingDown = true
    this.stage = 'starting'

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
      this.stage = 'watcher.close'
      await this.watcher.close()
      this.watcher = null
    }

    // Drain a restart already in flight. The latch makes every QUEUED job a no-op, but a job that
    // began before the latch is mid `close() → listen() → registerAlias()` and must finish, or its
    // alias lands after the removal below. Never rejects (the chain self-catches).
    this.stage = 'restartWorkChain'
    await this.restartWorkChain

    // And the background closure build, so its `turbo --dry` child never outlives the runner.
    this.stage = 'closureBuild'
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
    this.stage = 'removeAlias'
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
      this.stage = 'turboWatch.kill'
      await this.turboWatch.kill()
      this.turboWatch = null
    }

    if (this.uiDev) {
      this.stage = 'uiDev.kill'
      await this.uiDev.kill()
      this.uiDev = null
    }

    for (const { app, server } of this.appServers) {
      this.stage = `server.close(${app.name})`
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

    // Unhook the module-scoped sink that `appendRunnerLog` writes through — but only while it is still
    // OURS. The constructor re-points this global on every construction, and two runners can share one
    // process (the suite builds many), so an unconditional null here would let runner A's teardown
    // silently send runner B's narration nowhere: the same defect in the opposite direction.
    if (logSink === this.sink) logSink = null
    this.stage = 'done'
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
