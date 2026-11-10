/**
 * @fileoverview
 *
 * Unified Development Server Runner
 *
 * Discovers and runs API apps under each `apps/<app>/api` folder that contains `serverless.yml`.
 *
 * Ports: `{APP}_PORT`, then `process.env.PORT`. An app that pins neither binds an OS-assigned
 * ephemeral port — there is no static default.
 * URL prefix: `/api/v1`.
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
  DEV_SERVING_MARKER,
  loadPackageConfig,
  readAppAliasName,
  readCloudOrigin,
  readLocalContext,
} from '@slip-stream-kit/config/internal'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import * as fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

import { readAppRelease } from 'src/lib/app-release'
import { OperationError } from 'src/lib/errors/operation-error'
import { DEFAULT_DEV_PROXY_PORT } from 'src/lib/infra-kit-config'

import { buildClosureMap, selectPackageRestartTargets } from './dep-closure.js'
import type { ClosureMap, DryRunner } from './dep-closure.js'
import { DevContextStore } from './dev-context-store.js'
import type { DevUi } from './dev-ui.js'
import {
  classifyDistChange,
  findMonorepoRoot,
  getAppDistDirs,
  getPackageDistDirs,
  normalizeAppInclude as normalizeAppIncludePure,
  usesInfraKitVitePlugin,
} from './discovery.js'
import type { DiscoveredUiApp } from './discovery.js'
import { DistBuildTracker } from './dist-build-tracker.js'
import { HealthLedger } from './health-ledger.js'
import { defaultHealthProbe } from './health-probe.js'
import type { HealthProbe, ProbeTarget } from './health-probe.js'
import { assertHelperVersionFloor } from './helper-version-floor.js'
import { launchScript } from './launch-script.js'
import { findDegradedRoutes, formatPairingRefusal, resolveProxyRoutes } from './local-pairing.js'
import type { DegradedRoute, LaunchedUi, ResolvedProxyRoute } from './local-pairing.js'
import { currentService } from './log-attribution.js'
import { DevLogSink, panelStream } from './log-sink.js'
import { killDescendantGroupsNow } from './managed-child.js'
import {
  installModuleGeneration as installGenerationHook,
  isModuleGenerationSupported,
  resolveStopBudget,
  selfDistDir,
} from './module-generation.js'
import type { ModuleGenerationHandle } from './module-generation.js'
import { installOutputIntercept } from './output-intercept.js'
import type { OutputIntercept } from './output-intercept.js'
import { findPortConflicts } from './ports.js'
import { deriveTargetLabel } from './presets.js'
import type { ProxySource } from './presets.js'
import {
  createPortlessDriver,
  formatPortlessCommand,
  listRoutes as listPortlessRoutes,
  readCaPath,
} from './proxy/portless-driver.js'
import type { PortlessDriver } from './proxy/portless-driver.js'
import { serviceInstallCommand } from './proxy/portless-link.js'
import { describeStaleFiles, isHotReloadableChange } from './reload-scope.js'
import { DevRenderer, resolveEndpointUrl } from './render.js'
import type { DegradedRow, EndpointRow, HealthState, ProxyRouteRow, ReadySummary, UiRef } from './render.js'
import { RestartScheduler } from './restart-scheduler.js'
import { RowActivity } from './row-activity.js'
import { resolveRunPlan } from './run-plan.js'
import type { BuildRunner, DevServerOptions, IApiAppConfig, IAppServer, StartedApp } from './runner-types.js'
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
  /** This runner's own `.infra-kit/dev-context/<app>.json` fragments. */
  private readonly devContext: DevContextStore
  private readonly appServers: IAppServer[] = []
  /** Per-row request rate and error count — the live numbers of the panel besides health. */
  private readonly rows = new RowActivity({
    errorsOf: (tag) => {
      return this.sink.statsFor(tag).errors
    },
    onFirstError: (tag) => {
      this.renderer.log(`⚠️  ${tag} reported its first error → ${homeShorten(this.sink.pathFor(tag))}`, 'warn')
    },
  })

  /**
   * The last {@link ReadySummary} painted. Kept so {@link refreshStatus} can repaint the panel with
   * fresh live fields without re-deriving the static half (URLs, aliases, watch summary) every tick.
   */
  private lastSummary: ReadySummary | null = null
  /** Epoch ms at which the session went ready — the source of the panel's heartbeat. */
  private readyAt = 0
  /**
   * Whole-graph ESM invalidation, when available. `null` means restarts re-import handler entries only
   * (the runtime lacks `module.registerHooks`, or `INFRA_KIT_DEV_NO_GENERATION=1` turned it off) — the
   * runner then falls back to classifying changes by entry-ness and still reports honestly.
   */
  private moduleGeneration: ModuleGenerationHandle | null = null
  /** Active chokidar watcher in `--watch` mode; closed on {@link shutdown}. */
  private watcher: FSWatcher | null = null
  private static readonly WATCH_DEBOUNCE_MS = 400
  /** When a restart runs and which changed files it answers for; the runner supplies the restart. */
  private readonly restarts = new RestartScheduler({
    debounceMs: DevServerRunner.WATCH_DEBOUNCE_MS,
    isStopped: () => {
      return this.shuttingDown
    },
    onError: (key, error) => {
      this.renderer.log(`Restart error (${key}): ${String(error)}`, 'error')
    },
  })

  /** Serialized restarts so rapid saves never bind :port while the previous server is still shutting down. */
  private restartWorkChain: Promise<void> = Promise.resolve()
  private static readonly PORT_RELEASE_DELAY_MS = 200
  /** Self-rescheduling backend liveness probe; cleared on {@link shutdown}. Null when unarmed (UI-only). */
  private livenessTimer: ReturnType<typeof setTimeout> | null = null
  /** `--reuse` found this worktree already serving the plan: this runner owns nothing and only idles. */
  private reusing = false
  /** Holds the process open while {@link reusing} — nothing else it owns would. */
  private keepAlive: ReturnType<typeof setInterval> | null = null
  private servingAnnounced = false
  /** The run's label, as the ready header names it; the serving marker repeats it. */
  private targetLabel = ''
  /** Probe history and derived state of every endpoint row. */
  private readonly health = new HealthLedger((message, level) => {
    this.renderer.log(message, level)
  })

  /** The row state for a tag — the runner's one read of the ledger, kept as a method for its callers. */
  private healthOf(tag: string): HealthState {
    return this.health.stateOf(tag)
  }

  /** `<ui-package>` → `<app>/ui` tag, so {@link uiTargets} can name the rows {@link uiPortMap} keys by package. */
  private readonly uiTagByPackage = new Map<string, string>()
  /** Liveness re-probe cadence. A wedged-but-not-crashed backend is caught within THRESHOLD ticks. */
  private static readonly LIVENESS_INTERVAL_MS = 5000
  private readonly options: DevServerOptions
  /** Build runner seam — real turbo shell-out by default, injectable for tests. */
  private readonly runBuild: BuildRunner
  /** Which build wrote a changed dist file, what it emitted through, and the recovery of a save it missed. */
  private readonly builds: DistBuildTracker
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
   * service's file. `null` on a `--json` / `--agent` / piped run, where stdout must stay byte-clean.
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
   * Packages of boot-failed backends whose routes {@link holdFailedBackendsLocal} pinned at their own local
   * alias. Empty unless the run stays resident under `--watch` with a backend down.
   */
  private readonly heldLocalPkgs = new Set<string>()
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
   * {@link proxiesFor}. It is committed into the static header. A boot-failed backend's route already reads
   * `local` here (it is held, see {@link holdFailedBackendsLocal}); that it is DOWN is owned by the
   * self-clearing {@link degradedRows}, not this list.
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
  /** Every `<release>.<package>.<repo>` alias this runner registered; removed one-by-one in {@link shutdown}. */
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
    this.builds = new DistBuildTracker({
      runBuild,
      log: (message, level) => {
        this.renderer.log(message, level)
      },
      isStopped: () => {
        return this.shuttingDown
      },
    })
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
    const ownsTty = ownsTerminal(this.options)

    this.intercept = ownsTty
      ? installOutputIntercept({ sink: this.sink, fallbackService: RUNNER_SERVICE, currentService })
      : null
    // The renderer owns all terminal output + the log tee; construct it before the first narrate below.
    //
    // `isTTY` is passed EXPLICITLY rather than left to DevRenderer's `process.stdout.isTTY` default. The
    // default is wrong for exactly the case that reaches this line with a real TTY: `--json`, where
    // `selectDevUi` returns no renderer precisely BECAUSE the run does not own the terminal, so the
    // fallback built here would start an ANSI spinner and write escape frames into a stream whose whole
    // contract is that it parses. `ownsTerminal` is the same predicate that decides the intercept above,
    // which keeps the two from ever disagreeing about who owns the screen.
    this.renderer =
      renderer ??
      new DevRenderer({ appendLog: appendRunnerLog, verbose: this.options.verbose ?? false, isTTY: ownsTty })
    this.healthProbe = healthProbe
    this.devContext = new DevContextStore(path.join(process.cwd(), '.infra-kit', 'dev-context'))

    // Walk up from the consumer repo cwd to the monorepo root.
    this.monorepoRoot = findMonorepoRoot(process.cwd())

    if (process.env.DOPPLER_PROJECT != null || process.env.DOPPLER_ENVIRONMENT != null) {
      this.renderer.log('🔐 Doppler env detected (DOPPLER_PROJECT / DOPPLER_ENVIRONMENT)', 'debug')
    }
  }

  /** Thin delegator to the pure {@link normalizeAppIncludePure} over the runner's `--app` list. */
  private normalizeAppInclude(): string[] | null {
    return normalizeAppIncludePure(this.options.include)
  }

  public async start(): Promise<void> {
    // Backend readiness clock (UI is fire-and-forget, so `ready in Xs` is BE-only — labeled honestly).
    const bootStart = Date.now()
    const include = this.normalizeAppInclude()
    const watch = this.options.watch ?? false

    // Read by the apps' own Powertools loggers, not by ours. `POWERTOOLS_DEV` routes them through the
    // global console, so `output-intercept` files each line under its real level; without it, Powertools
    // writes through a private Console and the level is only inferred from the fd (stderr = warn).
    process.env.POWERTOOLS_DEV ??= 'true'
    process.env.LOG_LEVEL ??= 'DEBUG'

    this.renderer.narrate('🚀 Starting Development Server Runner')

    if (watch) {
      this.renderer.narrate('👀 Watch mode: will rebuild and restart on file save')
    }

    const { apps, uiApps, apiAppsAll, uiAppsAll, wantedLocalPkgs, presetProxy } = await resolveRunPlan(
      {
        options: this.options,
        monorepoRoot: this.monorepoRoot,
        log: (message, level) => {
          this.renderer.log(message, level)
        },
      },
      include,
    )

    if (await this.endsBeforeBoot(apps, uiApps)) return

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
      this.assertNoBootFailuresWhenReusing(apps.length)
    }

    // The label for what the user asked to run. Derived from the post-`--app` sets — not from
    // `include` (app names only). Hoisted above the refusal below so both it and the ready header name
    // the run the same way.
    const target = deriveTargetLabel({
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
    // restart target now (see `resolveRestartTargets`), so the next save can bring the backend up. It stays
    // resident — but with the route HELD at the backend's local alias (`holdFailedBackendsLocal`), never on
    // cloud: the frontend fails loudly on that route, under a self-clearing `⚠ … ● dead alias` row, until
    // the backend is back.
    //
    // That healing is real, and it is the `infraKit()` vite PLUGIN that makes it real: its `configureServer`
    // hook watches the dev-context fragment dir, re-resolves the proxy, and restarts vite when the resolved
    // map changes (verified live — `[vite] server restarted.` the moment a fragment appears). A UI that
    // instead wires the bare `infraKitDev()` helper directly in its vite config has NO such watcher: its
    // proxy is baked at config load, so a backend recovering mid-session will not flip its route back to
    // `local` until that UI is restarted. Discovery treats both shapes as managed, so on such a UI this row
    // can clear while the traffic still goes to cloud. The plugin is the supported wiring and every
    // consumer uses it today; stated here so the assumption is on the record rather than merely held.
    this.targetLabel = target

    if (watch) this.holdFailedBackendsLocal()
    this.degradedRoutes = await this.collectDegradedRoutes(uiApps, wantedLocalPkgs, presetProxy)
    if (this.degradedRoutes.length > 0 && !watch) {
      throw new Error(formatPairingRefusal(this.degradedRoutes, target))
    }

    // Collapse the boot spinner into the calm ready header (BE endpoints + UI reference lines).
    // Runs for a UI-only session too, so it never leaves a blank screen. The route dump is opt-in.
    await this.printReady(apps, uiApps, bootStart, target)
    this.announceServingOnce()
    if (this.options.routes) {
      this.printRouteDump()
    }

    // Everything the user asked for is dead and there is no UI to fall back on: there is nothing left
    // to serve, watch, or proxy. Resident-but-empty is the worst of both worlds — it looks like a
    // running dev server and exits 0 when finally interrupted, so a CI step or a script would call it
    // a success. Fail loudly instead. A PARTIAL failure stays resident: the survivors are still useful,
    // and under `--watch` a boot-failed app IS retried on the next save (`resolveRestartTargets`) —
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
      const config = await loadPackageConfig(ui.path).catch(() => {
        return undefined
      })

      const dev = config?.dev

      if (!dev?.proxy) continue

      const overrides = presetProxy[ui.name] ?? {}

      const routes = Object.fromEntries(
        Object.entries(dev.proxy.routes).map(([route, spec]) => {
          return [route, { ...spec, pinnedLocal: overrides[route] === 'local' }]
        }),
      )

      uis.push({ app: ui.name, routes, cloudUrl: readCloudOrigin(config?.deployedUrlEnv).url })
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
      held: this.heldLocalPkgs,
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
   * unmatched-targets line in {@link resolveRunPlan}), so it is `--json`/`--agent`-safe for free.
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
      // ONE frontend gave up; the engine and its siblings live on. Same package→app mapping as `onLine`,
      // so the row this marks down is the row the ready header printed.
      onTaskFailure: (pkg) => {
        this.markUiTaskFailed(tagByPackage.get(pkg) ?? `${pkg}/ui`)
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
    this.renderer.log('   `SEARCH_ENGINE_PORT=`); or run a subset with', 'error')
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
   * **Probe only — never start, never elevate.** The daemon is installed once, out-of-band. Identity is
   * proven **on the wire** (`X-Portless`), never from portless's state files — see
   * {@link defaultIsProxyServing}. The failure is classified rather than reported generically.
   *
   * @throws When portless is missing, or no portless daemon is serving TLS on the proxy port.
   */
  // Why probe-only: `:443` is privileged, and portless binds it by re-execing through `sudo` with an
  // inherited stdio, which a detached child cannot answer. There is deliberately no unprivileged fallback
  // either: a fallback puts the port back in the URL, which is the whole thing this design removes.
  //
  // Why the wire and not the state files: those are process-global singletons that any other daemon's
  // start rewrites and any stop deletes, which would make a perfectly healthy `:443` daemon look dead.
  //
  // Why classify: "not serving" has four unrelated causes with different fixes — portless was never
  // installed as a dependency at all, its one-time OS service was never registered, its OS service IS
  // registered but the daemon it starts is currently down (crashed/stopped), or something ELSE is
  // squatting on the port and installing/trusting portless would not free it.
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

    // The one exception is the ROOT install line: portless bakes the script path AND the node it is invoked
    // with into the plist, so that line carries the stable `~/.infra-kit/portless/dist/cli.js` whenever the
    // link resolves, and the stable `~/.infra-kit/node` whenever that file is this process's own inode —
    // both version-specific paths would dangle at the next `pnpm add -g infra-kit`. The seam is `{ home }`
    // only (no `stableNode` verdict): this is a hot startup path that never spawns, so the inode check is
    // all it pays; a copy of Node is `doctor`'s to vouch for. `status` and `trust` run now, against this
    // driver's bin, and stay on it.
    const install = serviceInstallCommand(bin, this.options.portlessLink ?? { home: os.homedir() })

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
          `    ${install}\n` +
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
        `    ${install}\n` +
        '`infra-kit doctor` checks the daemon and CA trust state.',
    )
  }

  /**
   * Register `<release>.<package>.<repo>` → `port` with portless and return the alias HOST
   * (`<release>.<package>.<repo>.localhost`). The alias IS the app's only address, so a failure here is fatal
   * rather than a silent downgrade — an app nobody can reach is not a running app.
   *
   * @throws When the package name yields no legal DNS label, or portless rejects the registration.
   */
  private async registerAppAlias(packageName: string, appDir: string, port: number): Promise<string> {
    const name = readAppAliasName(packageName, appDir)

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
        this.rows.recordRequest(tag, Date.now())
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
      this.devContext.write(app, boundPort, alias)
    } catch (error) {
      this.renderer.log(`⚠️  Failed to write dev-context fragment for ${app.name}: ${String(error)}`, 'warn')
    }

    this.renderer.narrate(`✅ ${app.name} started on port ${boundPort}`)

    return { server, boundPort, alias }
  }

  /**
   * Pin every boot-failed backend's routes at the local alias it WILL register once it boots, so no
   * frontend falls back to cloud while it is down.
   *
   * Without this a failed backend writes no fragment, and the vite helper's `pickSource` sends its
   * `from: ['local','cloud']` routes to `default: 'cloud'` — the frontend then quietly talks to the shared
   * backend the user chose NOT to use. A held fragment names the backend's own origin, so the route stays
   * `local` and every request on it fails at portless (no alias is registered) until the backend is up.
   * Recovery then needs nothing extra: {@link startOneApp} registers that same alias and rewrites the
   * fragment with the same origin.
   *
   * The fragment is the published v2 wire shape, so every helper already pinned in a consumer obeys it.
   * `port: 0` records that nothing is bound. Non-fatal per app, like the fragment write in startOneApp.
   */
  private holdFailedBackendsLocal(): void {
    for (const { app } of this.failedApps) {
      try {
        this.devContext.write(app, 0, `${readAppAliasName(app.packageName, app.path)}.localhost`)
        this.heldLocalPkgs.add(app.packageName)
      } catch (error) {
        this.renderer.log(`⚠️  Failed to hold ${app.name}'s routes local: ${String(error)}`, 'warn')
      }
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

  /**
   * Schedule a restart of the given apps (1 or N), serialized against other restarts via
   * {@link scheduleRestartWork}. A single-app dist change passes `[app]`; a dependency-package
   * dist change passes every running app. The `turbo watch` engine has already rebuilt `dist/`,
   * so the runner only bounces the fastify server(s) — no build here.
   */
  private restart(apps: IApiAppConfig[], staleFiles: string[] = []): Promise<void> {
    if (this.shuttingDown) return Promise.resolve()

    return this.scheduleRestartWork(async () => {
      // Re-checked inside the chain: this job may have queued behind a restart that was still
      // running when shutdown() latched, so the flag can flip between scheduling and execution.
      if (this.shuttingDown) return

      await this.runRestart(apps, staleFiles)
      // Not awaited: the rebuild it may start must not hold the chain the rebuild's own restart queues on.
      void this.builds.recoverLostSaves(this.builds.triggeringBuilds(staleFiles))
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
    // a few lines later. The liveness tick can fire in that window, and `healthOf` treats an ABSENT
    // entry as `unknown` — a row with no dot at all for a server that is already serving. A fresh entry is
    // the honest prior instead: never-up, which for a backend reads `● down` until a probe says otherwise.
    this.health.track(tag, 'api')
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
            // `refreshStatus` paints the answer.
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
        // A rejected teardown stopped before its reaps; the exit below must not orphan turbo / vite.
        .catch(() => {
          killDescendantGroupsNow()
        })
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
            // which is also what takes its frontend's `⚠ … ● dead alias` row down (see `degradedRows`).
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
        // about. Routed through `markDown`, not the probe path, because the soft path would leave the
        // row one failure short of the threshold, i.e. GREEN, for a server that does not exist.
        if (entry == null) {
          this.health.markDown(tag, 'api')
          this.refreshStatus()

          return { label: `${app.name} ● down`, healthy: false }
        }

        // Through the SAME state machine as every tick, so the panel's dot and this line report the same
        // probe. They used to be two verdicts computed from one result, and they could disagree.
        const target: ProbeTarget = { tag, port: entry.boundPort, kind: 'api' }
        const outcome = await this.healthProbe(target)

        this.health.record(target, outcome)
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

    // `tsc -b` emits through a type error, so the new code IS what now runs — restarting onto it is right
    // (blocking would freeze dev on any shared-lib type error). Only the green check would be a lie.
    const buildErrors = this.builds.describeBuildErrors(this.builds.triggeringBuilds(staleFiles))

    if (buildErrors !== undefined) {
      this.renderer.log(`⚠️  Restarted ${labels} — ${buildErrors}`, 'warn')

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
   * engine's corpse has not already said. Recorded as `dead`, which {@link HealthLedger.stateOf} reads ONLY in the
   * never-up branch: a UI that HAS been up keeps its ordinary probe-established death, because turbo does
   * not kill its task process groups and our reap is best-effort — an orphaned vite may well still be
   * serving, and it would be a live, hot-reloading UI we had just painted red.
   */
  private markUiEngineDead(): void {
    if (this.shuttingDown) return

    for (const { tag, kind } of this.uiTargets()) {
      this.health.markDead(tag, kind)
    }
    this.refreshStatus()
  }

  /**
   * ONE frontend's `dev` task died while the engine — and every sibling frontend — kept running.
   *
   * Marks the row down hard (via {@link HealthLedger.markDown}), not through the soft probe path. Under
   * `--no-ui-health` the failure is narrated but no dot is invented for it, since the row carries no
   * health entry by the user's own choice.
   */
  // This is the other half of `--continue=dependencies-successful`. The flag stops one broken UI from
  // cancelling the whole run, but it also means `markUiEngineDead` no longer fires for that UI: the engine
  // is alive, so nothing would contradict the row's `◌ starting` until the never-up threshold expired ~30s
  // later. Turbo's own per-task verdict is the only live signal, so it is routed here.
  //
  // The hard mark is safe even for a UI that HAS been up, unlike the engine-death case: turbo reports this
  // only because the task process itself exited, so there is no orphaned-but-serving vite to paint red by
  // mistake.
  //
  // Under `--no-ui-health` the health state also cannot dedupe the narration — acceptable because turbo
  // emits this verdict exactly once per task per run (measured; see `parseTurboTaskFailure`), so there is
  // no repeat to suppress.
  private markUiTaskFailed(tag: string): void {
    if (this.shuttingDown) return

    if (this.uiHealthEnabled()) {
      // Already down (turbo can restate a verdict) — don't narrate the same death twice.
      if (this.healthOf(tag) === 'down') return

      this.health.markDown(tag, 'ui')
    }

    // Only claim the others survived when there ARE others. When the failing UI is the only one turbo is
    // running, its exit takes the engine with it, and `markUiEngineDead` + `reportEngineDeath` fire right
    // behind this line — "other frontends are unaffected" would be contradicted on the very next row.
    const others = this.uiTagByPackage.size > 1 ? '; other frontends are unaffected' : ''

    this.renderer.log(`⚠️  ${tag} failed to start — its \`dev\` task exited${others}`, 'error')
    this.refreshStatus()

    // `--reuse` exits rather than serve a test run a frontend that is not there.
    // `.finally`, as on the budget stop: a rejecting teardown must still exit, or the test runner's
    // `webServer` waits forever on a process that serves nothing.
    if (this.options.reuse) {
      void this.shutdown()
        // A rejected teardown stopped before its reaps; the exit below must not orphan turbo / vite.
        .catch(() => {
          killDescendantGroupsNow()
        })
        .finally(() => {
          this.options.onExitRequest?.(1)
        })
        .catch(() => {})
    }
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
      // The watch engine gets its own file rather than interleaving raw child bytes into any service's
      // log — written THROUGH the sink, so it is under the same byte cap as every other service.
      logFile: this.sink.pathFor(WATCH_SERVICE),
      appendLog: (text) => {
        this.sink.write(WATCH_SERVICE, text)
      },
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

    this.builds.distDirs = allDistDirs

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
      ...(usePoll ? { backend: 'polling', pollingInterval: 400 } : {}),
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
    // the `RestartScheduler` collapses a burst onto one timer per key. `unlink` is safe to route
    // through the same classifier because `classifyDistChange` is pure path arithmetic — it
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
    // A restart of EVERY app is already pending (the no-closure-map fail-safe below): this app is in
    // it. A second timer under the app's own key would restart it again moments later — one save,
    // two restarts, and twice the module generations charged to the reload budget. Fold in instead.
    if (this.restarts.isAllPending()) {
      this.scheduleRestartAll(apps, filePath)

      return
    }

    this.restarts.schedule(app.name, filePath, (changed) => {
      return this.restart([app], changed)
    })
  }

  /** One debounced restart of every launched app, absorbing the per-app restarts still pending. */
  private scheduleRestartAll(apps: IApiAppConfig[], filePath: string): void {
    this.restarts.scheduleAll(
      apps.map((app) => {
        return app.name
      }),
      filePath,
      (changed) => {
        return this.restart(apps, changed)
      },
    )
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
      // Fail-safe: no closure map / no package identity → restart every launched app, so a
      // `turbo --dry` failure never silently drops a needed restart.
      this.scheduleRestartAll(apps, filePath)

      return
    }

    // Empty target set = the package is UI-only or every dependent opted out → no restart.
    //
    // Keyed per TARGET APP, not per package dir. `turbo watch build`'s dep-inclusive rebuild cascades a
    // shared-lib edit into the package's own dist AND, moments later, its dependent app's dist — two
    // chokidar `change` events for one save, this branch for the first and the app-dist branch above
    // for the second. A package-dir key and an app-name key are two different timers of the `RestartScheduler`
    // entries, so both timers used to elapse independently and fire `restart()` twice for the same app.
    // Scheduling by app name here collapses both events onto the SAME entry — `RestartScheduler.debounce`
    // already cancels a pending timer for a key it sees again — so the app restarts once per burst.
    // Same fold as the app-dist branch: a restart of every app pending from before the map landed
    // already covers these targets.
    if (targets.length > 0 && this.restarts.isAllPending()) {
      this.scheduleRestartAll(apps, filePath)

      return
    }

    for (const target of targets) {
      this.restarts.schedule(target.name, filePath, (changed) => {
        return this.restart([target], changed)
      })
    }
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
    // on every `--json` / piped run — has no `refresh`. Pruning in there meant the window was never
    // trimmed off the TTY path, so the request window grew without bound while `onRequestLog` copied the whole
    // array on every request. Unbounded memory and O(n²) CPU, on the runs that live longest (a piped
    // `dev --watch` left up all day) specifically.
    this.rows.prune(now)

    this.renderer.refresh?.({
      ...summary,
      sessionUptimeMs: now - this.readyAt,
      // Re-derived, never carried over from the boot summary: a `--watch` restart that brings the backend
      // back must take this row down with it (see `degradedRows`).
      degraded: this.degradedRows(),
      // A UI with no managed port has no endpoint row — only a reference line. It still gets its error
      // count, or its breakage would be counted into a file with nothing on screen pointing at it.
      uiRefs: summary.uiRefs.map((ref) => {
        return { ...ref, errors: this.rows.errors(ref.tag) }
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
          rpm: this.rows.requestsPerMinute(endpoint.tag),
          errors: this.rows.errors(endpoint.tag),
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

  /**
   * One liveness sweep over every running backend AND every managed frontend. Edge-triggered per ROW,
   * keyed by tag (so the counter survives an ephemeral-port rebind on restart) with the CURRENT port read
   * fresh each tick. The verdict rules live in {@link HealthLedger.record}; the threshold is what makes a normal
   * watch-restart (server down <1s, a single interval) invisible — only a genuinely wedged app stays down
   * across two sweeps.
   *
   * `/__health` probes are already filtered out of the live request tail ({@link startOneApp}'s
   * `onRequestLog`), and vite's ping is not a line vite logs, so this never spams. Bails once teardown has
   * latched so a closing server is not misread as down (the timer is also cleared in {@link shutdown}
   * before the servers close).
   */
  private async livenessTick(): Promise<void> {
    if (this.shuttingDown) return

    await Promise.all(
      [...this.apiTargets(), ...this.uiTargets()].map((target) => {
        return this.probeOne(target)
      }),
    )

    this.announceServingOnce()

    // The panel's heartbeat. It rides the probe tick that already exists rather than adding a timer of
    // its own, so the numbers on screen are exactly as fresh as the health behind them.
    this.refreshStatus()
  }

  /**
   * Print {@link DEV_SERVING_MARKER} the first time every probed row is up — a UI's row included, which the
   * ready header cannot promise, because vite is spawned after it. A row nothing probes (`unknown`) does not
   * hold it back; a failed app does, forever.
   */
  private announceServingOnce(): void {
    if (this.servingAnnounced || this.lastSummary == null || this.failedApps.length > 0) return

    const allUp = this.lastSummary.endpoints.every((row) => {
      const health = this.healthOf(row.tag)

      return health === 'ok' || health === 'unknown'
    })

    if (!allUp) return

    this.servingAnnounced = true
    this.renderer.log(`${DEV_SERVING_MARKER} ${this.targetLabel}`)
  }

  /**
   * `--reuse`: which of the plan's apps this worktree already serves. A backend counts when its dev-context
   * fragment's port answers `/__health`; a UI when its alias's port answers vite's ping — the same proofs
   * the panel's own rows use.
   */
  private async findServedApps(apps: IApiAppConfig[], uiApps: DiscoveredUiApp[]): Promise<string[]> {
    const routes = listPortlessRoutes()

    const checks = [
      ...apps.map((app) => {
        return {
          tag: `${app.name}/api`,
          kind: 'api' as const,
          port: readLocalContext(app.path).info.get(app.packageName)?.port ?? 0,
        }
      }),
      ...uiApps.map((ui) => {
        const label = readAppAliasName(ui.packageName, ui.path)

        return {
          tag: `${ui.name}/ui`,
          kind: 'ui' as const,
          port:
            routes.find((route) => {
              return route.name === label || route.name === `${label}.localhost`
            })?.port ?? 0,
        }
      }),
    ]

    const served = await Promise.all(
      checks.map(async (check) => {
        return check.port > 0 && (await this.healthProbe(check)) === 'ok'
      }),
    )

    return checks
      .filter((_check, index) => {
        return served[index]
      })
      .map((check) => {
        return check.tag
      })
  }

  /**
   * Whether the run is over before anything boots: an empty plan, or `--reuse` over the session this worktree
   * already runs. Under `--reuse` it also refuses what would leave the run half-working.
   */
  private async endsBeforeBoot(apps: IApiAppConfig[], uiApps: DiscoveredUiApp[]): Promise<boolean> {
    if (apps.length === 0 && uiApps.length === 0) {
      this.renderer.log('⚠️  No API or UI apps to run', 'warn')

      return true
    }

    if (!this.options.reuse) return false

    const served = await this.findServedApps(apps, uiApps)

    if (served.length > 0) {
      this.idleOverRunningSession(served)

      return true
    }

    await this.assertCloudRoutesHaveEnv(apps, uiApps)

    return false
  }

  /** `--reuse`: a test run against a half-up session fails on something unrelated to the change under test. */
  private assertNoBootFailuresWhenReusing(planned: number): void {
    const [first] = this.failedApps

    if (!this.options.reuse || !first) return

    throw new Error(
      `infra-kit dev: ${this.failedApps.length} of ${planned} app(s) failed to start. ` +
        `First failure (${first.app.name}): ${first.reason}`,
    )
  }

  /**
   * `--reuse` over a session this worktree already runs: start nothing, and stay up until a signal so the
   * caller's lifecycle (Playwright's `webServer`) has a process to own. Its shutdown then touches nothing:
   * every teardown step acts only on what this runner registered, and it registered nothing.
   */
  private idleOverRunningSession(served: string[]): void {
    this.reusing = true
    this.keepAlive = setInterval(() => {}, 60_000)
    this.renderer.log(`♻️  Reusing the dev server this worktree already runs (${served.join(', ')})`)
    this.servingAnnounced = true
    this.renderer.log(`${DEV_SERVING_MARKER} ${served.join(', ')}`)
  }

  /**
   * `--reuse` refuses up front what a human session only reports on its panel: a UI route that will proxy
   * to the deployed app, whose URL the loaded environment does not carry, fails every test that touches it.
   */
  private async assertCloudRoutesHaveEnv(apps: IApiAppConfig[], uiApps: DiscoveredUiApp[]): Promise<void> {
    const launched = new Set(
      apps.map((app) => {
        return app.packageName
      }),
    )

    const cloudBound: string[] = []

    for (const ui of uiApps) {
      const config = await loadPackageConfig(ui.path)

      const routes = Object.entries(config?.dev?.proxy?.routes ?? {}).filter(([, route]) => {
        return !route.from.includes('local') || !launched.has(route.packageName)
      })

      if (routes.length > 0 && !readCloudOrigin(config?.deployedUrlEnv).url) {
        const paths = routes.map(([routePath]) => {
          return routePath
        })

        cloudBound.push(`${ui.name}/ui ${paths.join(', ')} (${config?.deployedUrlEnv ?? 'no deployedUrlEnv'})`)
      }
    }

    if (cloudBound.length === 0) return

    throw new OperationError(undefined, {
      operation: 'start the dev servers',
      remediation: 'load an environment first (`infra-kit env-load -c dev`)',
      stderrExcerpt: `these routes proxy to the deployed app, whose URL is not loaded: ${cloudBound.join('; ')}`,
    })
  }

  /** Probe one target and fold the outcome in. Split out of {@link livenessTick} to keep both simple. */
  private async probeOne(target: ProbeTarget): Promise<void> {
    const outcome = await this.healthProbe(target)

    // Re-check AFTER the await: shutdown() may have latched and begun closing servers while this probe was
    // in flight, resolving it `refused` against a closing socket. Without this a tick that passed the
    // top-of-method bail could log a false `unhealthy` during teardown.
    if (this.shuttingDown) return

    this.health.record(target, outcome)
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
      held: this.heldLocalPkgs,
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

    this.health.track(tag, 'ui')

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
    // teardown begins; the `RestartScheduler` and `restart` read this flag to honour that.
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

    // Every step below acts on what this runner registered; a reusing runner registered nothing, and the
    // session it reused belongs to someone else's terminal.
    if (this.reusing) {
      if (this.keepAlive) clearInterval(this.keepAlive)
      this.keepAlive = null
      this.renderer.log('♻️  Left the reused dev server running')
      this.stage = 'done'

      return
    }

    this.renderer.log('🛑 Shutting down all servers...')

    // Silence every restart SOURCE before deregistering aliases below. Ordered first because alias
    // removal is not idempotent against a concurrent `startOneApp`: a chokidar event or an armed
    // debounce timer firing after the removal would re-register an alias into a set nothing drains
    // again, stranding it exactly like the force-quit case the removal is there to prevent.
    this.restarts.clear()

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
      this.devContext.remove(app)
    }

    // A backend still down at exit owns a HELD fragment (see `holdFailedBackendsLocal`) and no server.
    for (const { app } of this.failedApps) {
      if (this.heldLocalPkgs.has(app.packageName)) this.devContext.remove(app)
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
 * Whether this run owns the terminal — the single gate for BOTH the live UI and the output interception.
 *
 * Derived once and shared, never re-derived: a `--json` / `--agent` / piped run must keep a byte-clean stdout,
 * and interception there would file the machine-readable stream into a log and hand the caller nothing.
 */
export const ownsTerminal = (options: DevServerOptions): boolean => {
  return (options.tty ?? Boolean(process.stdout.isTTY)) && !options.json
}

/** What {@link CreateDevUi} gets from the runner to build the live UI. */
export interface DevUiInputs {
  /** File tee — the same appender the runner hands the plain renderer. */
  appendLog: (text: string) => void
  verbose: boolean
  /** A stdout whose `write` bypasses the output interceptor, so frames reach the terminal. */
  panel: NodeJS.WriteStream
}

/**
 * Builds the live terminal UI. Injected by `entry/dev-server.ts`: `dev/` sits below `tui/` and never
 * imports it, and the entry keeps it behind a dynamic import so React stays off the machine paths.
 */
export type CreateDevUi = (inputs: DevUiInputs) => Promise<DevUi>

/**
 * Select the terminal UI for this run: the injected live UI when the run owns the terminal, else the plain
 * {@link DevRenderer} (returned as `undefined` so the runner constructs its own default). `--json`/`--agent`
 * always forces plain — Ink must never seize a machine-readable stream.
 */
export const selectDevUi = async (options: DevServerOptions, createDevUi: CreateDevUi): Promise<DevUi | undefined> => {
  if (!ownsTerminal(options)) {
    return undefined
  }

  return createDevUi({ appendLog: appendRunnerLog, verbose: options.verbose ?? false, panel: panelStream() })
}

/**
 * Construct a {@link DevServerRunner}, start it, and return the instance so the caller
 * (the CLI entry point) can wire signal handlers to `shutdown()` and own process exit.
 * Selects the boot UI (Ink on a TTY, plain otherwise) before constructing the runner.
 */
export async function run(options: DevServerOptions, createDevUi: CreateDevUi): Promise<DevServerRunner> {
  const renderer = await selectDevUi(options, createDevUi)
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
