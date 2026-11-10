import { planAppRun } from './app-plan.js'
import type { DevPreset } from './presets.js'
import type { ServiceInstallSeams } from './proxy/portless-link.js'
import { DevRenderer } from './render.js'
import type { ServerlessLocalRun } from './serverless-local-run.js'

export type LogFn = (msg: string, level?: 'info' | 'warn' | 'error' | 'debug') => void

/**
 * Build seam: shells out to turbo by default (`launchScript`); injectable so
 * tests can run the orchestrator without a real build. `logFn` is optional so both
 * the verbose initial build and the terse restart builds keep their current output.
 */
export type BuildRunner = (cmd: string, logFn?: LogFn) => Promise<void>

export interface IApiAppConfig {
  /** App folder name (e.g. backoffice, client) */
  name: string
  /** Package name from package.json (e.g. sls-trvl-client) */
  packageName: string
  path: string
  /**
   * EXPLICITLY-configured preferred port (`{APP}_PORT`/`PORT`), or
   * `undefined` when unconfigured. Under dynamic allocation this is only a bind hint — the
   * ACTUAL port is the ephemeral one bound at start time (see {@link IAppServer.boundPort}).
   */
  preferredPort: number | undefined
  /**
   * The same resolution with the bare `PORT` tier DENIED — `{APP}_PORT` only.
   *
   * Both are resolved together in {@link DevServerRunner.discoverApiApps}, but the CHOICE between them
   * cannot be made there: it depends on how many
   * apps this run actually launches, and narrowing to the run plan happens later
   * ({@link DevServerRunner.resolveRunPlan}). A bare `PORT` is not app-scoped, so in a multi-app run it
   * gives every app the same preferred port and {@link DevServerRunner.assertNoPortConflicts} then
   * refuses to start over duplicates the environment manufactured. Carrying both values forward is what
   * lets a single-app run keep honouring `PORT` while a multi-app run ignores it.
   */
  appScopedPort: number | undefined
  prefixUrl: string
}

/**
 * Runner options, parsed by the CLI entry point (`--watch`, `--app`) and threaded
 * through `run()`. The entry owns flag parsing; the runner never reads `process.argv`
 * itself. App selection is `--app` only; ports come from env (see `resolvePreferredPort`).
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
   * App folder (`infra-kit dev <app>`): runs that app plus the backends its proxy routes can run
   * locally ({@link planAppRun}). Unset → run everything (`*`). `include` (`--app`/`--self`) further
   * narrows the resolved set.
   */
  app?: string
  /**
   * In-memory run plan, produced by the interactive wizard or `--target`. When set it is used verbatim
   * — it WINS over `app` and the default `*`. This is how part-level selection (`<app>/ui` without
   * `<app>/api`) is expressed, which `include` (app-name-only) cannot.
   */
  presetDef?: DevPreset
  /**
   * Run each discovered API app in its own Orca pane (one tab, N panes), supervised by a
   * resident process that closes the tab on signal. Falls back to single-process dev when
   * Orca cannot show the panes. Handled by `runOrcaDevServer`, not the in-process `DevServerRunner`.
   */
  orca?: boolean
  /**
   * Test-runner mode (`--reuse`), for a caller that needs the apps served and does not care who serves them
   * — Playwright's `webServer` is the one this exists for:
   *  - when this worktree already serves any app of the plan, start nothing: announce it and idle until a
   *    signal, owning nothing a shutdown could tear down;
   *  - otherwise refuse cloud routes with no `INFRA_KIT_ENV` before anything starts, and exit on the first
   *    app that fails to boot rather than staying resident half-up.
   * Either way `DEV_SERVING_MARKER` is printed once everything answers its probe.
   */
  reuse?: boolean
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
   * Structured `--json` / `--agent` mode. When true, {@link run} forces the plain {@link DevRenderer} — Ink
   * must never seize a machine-readable stream. The runner itself never reads it.
   */
  json?: boolean
  /**
   * Background liveness-probe interval in ms (default {@link DevServerRunner.LIVENESS_INTERVAL_MS}, 5000).
   * A test seam only — lets a test drive the monitor loop fast; production never sets it.
   */
  livenessIntervalMs?: number
  /**
   * Where `~/.infra-kit/portless` is looked up when the daemon-down refusal prints `service install`
   * (default: the real home + `existsSync`). A test seam only — it lets a test force the link-resolved and
   * the real-bin rendering without a real `~/.infra-kit` on the author's machine; production never sets it.
   */
  portlessLink?: ServiceInstallSeams
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

/** What a successful `DevServerRunner.startOneApp` hands back: a bound server and the alias it took. */
export interface StartedApp {
  server: ServerlessLocalRun
  /** The ACTUAL port bound at start (ephemeral or preferred), reported by `server.start()`. */
  boundPort: number
  /** Layer-B alias host (`<release>.<package>.<repo>.localhost`) — the app's only address. */
  alias: string
}

export interface IAppServer {
  app: IApiAppConfig
  server: ServerlessLocalRun
  /** The ACTUAL port bound at start (ephemeral or preferred), reported by `server.start()`. */
  boundPort: number
  /** Layer-B alias host (`<release>.<package>.<repo>.localhost`) — the app's only address. */
  alias: string
  /** Epoch ms of this server's last (re)start — the source of the panel's `up Xs` field. */
  startedAt: number
  /** Watch-triggered restarts so far. */
  restarts: number
}
