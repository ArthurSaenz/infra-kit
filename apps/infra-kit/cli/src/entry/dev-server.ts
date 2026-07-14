/**
 * Long-running CLI entry for the local dev-server. Owns flag parsing and wires signal
 * handling to `src/dev/signal-shutdown` — the orchestrator (`src/dev/dev-server`) stays
 * signal- and exit-agnostic. Kept off the eager cli.js graph: entry/cli.ts reaches this
 * module (and the fastify/chokidar it pulls in) only via `await import(...)`, so
 * those heavy deps never load on the machine command paths.
 */
import { Command } from 'commander'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { runCmuxDevServer } from 'src/dev/cmux-dev'
import { formatFault, registerCrashBarrier } from 'src/dev/crash-barrier'
import { run } from 'src/dev/dev-server'
import type { DevServerOptions } from 'src/dev/dev-server'
import type { WizardResult } from 'src/dev/dev-wizard-run'
import { resolveSelfAppName } from 'src/dev/discovery'
import { rawStdoutWrite } from 'src/dev/log-sink'
import { explainTargetKey } from 'src/dev/presets'
import { registerSignalShutdown } from 'src/dev/signal-shutdown'
import { isCmuxAvailable } from 'src/integrations/cmux'
import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import type { DevPreset } from 'src/lib/infra-kit-config'

/** Raw option object as produced by Commander (comma-joined strings). */
export interface DevCliOptions {
  watch?: boolean
  app?: string
  /**
   * Comma-separated `<app>/<part>` target keys (`--target=client/api,client/ui`). The part-level
   * selector `--app` cannot express: `--app=client` expands to every part `client` has. Same grammar as
   * a `devServersPresets` key, so a wizard selection round-trips into a command you can paste.
   */
  target?: string
  /** Named preset positional (`infra-kit dev <preset>`); selects launch targets from `devServersPresets`. */
  preset?: string
  cmux?: boolean
  self?: boolean
  verbose?: boolean
  /** Print each app's registered routes at startup (opt-in; off keeps the calm default screen). */
  routes?: boolean
}

/**
 * Turn `--target=<app>/<part>,…` into the in-memory preset the runner already understands, or
 * `undefined` when the flag is absent (leaving `preset`/`*` resolution untouched). Validated against the
 * same grammar as a `devServersPresets` key, but with a message that names the FLAG — a user typing
 * `--target=client` must not be told about `devServersPresets`.
 */
const toPresetDef = (targets: string[] | null): DevPreset | undefined => {
  if (targets == null) return undefined

  for (const key of targets) {
    if (explainTargetKey(key) !== null) {
      throw new Error(`infra-kit dev: invalid --target "${key}" (expected "<app>/api" or "<app>/ui").`)
    }
  }

  return {
    apps: Object.fromEntries(
      targets.map((key) => {
        return [key, {}]
      }),
    ),
  }
}

/** Split a comma-separated flag value into a trimmed, non-empty list (`null` when unset/empty). */
const splitList = (value: string | undefined): string[] | null => {
  if (value == null) return null

  const parts = value
    .split(',')
    .map((s) => {
      return s.trim()
    })
    .filter(Boolean)

  return parts.length > 0 ? parts : null
}

/**
 * Map raw Commander flags to the orchestrator's typed options. Shared by the
 * `infra-kit dev` subcommand and the standalone entry so the two never diverge.
 * `self` is passed through as-is here — it's resolved to `include` later, in
 * `runDevServer`, where `--app` (if also given) is allowed to win.
 */
export const toDevServerOptions = (raw: DevCliOptions): DevServerOptions => {
  return {
    watch: raw.watch ?? false,
    include: splitList(raw.app),
    preset: raw.preset,
    presetDef: toPresetDef(splitList(raw.target)),
    cmux: raw.cmux ?? false,
    self: raw.self ?? false,
    verbose: raw.verbose ?? false,
    routes: raw.routes ?? false,
  }
}

/**
 * Resolve `--self` into an `include` list, without mutating `options`. `--app` (an
 * explicit `include`) wins over `--self` when both are given — self is only a
 * convenience default for scripts that don't want to hardcode their app name.
 * Lets `resolveSelfAppName`'s error (not inside `apps/<app>/...`) propagate as-is;
 * the caller's top-level catch turns it into a clean message + non-zero exit.
 */
const resolveSelfOptions = (options: DevServerOptions): DevServerOptions => {
  if (!options.self || options.include) {
    return options
  }

  return { ...options, include: [resolveSelfAppName(process.cwd())] }
}

/**
 * Start the dev-server, then wait for an OS signal and shut every server down
 * cleanly before exiting. Signal handling and exit are delegated to
 * {@link registerSignalShutdown}: a second signal force-quits, a rejected teardown
 * is logged, and the process exits `128 + signo` rather than a dishonest `0`.
 */
export const runDevServer = async (rawOptions: DevServerOptions): Promise<void> => {
  const options = resolveSelfOptions(rawOptions)

  // `--cmux`: one workspace, one pane per app. `runCmuxDevServer` owns its own
  // signal handling and never returns, so return before wiring the in-process
  // handlers below. Fall through to single-process dev when cmux isn't installed.
  if (options.cmux) {
    if (await isCmuxAvailable()) {
      await runCmuxDevServer(options)

      return
    }

    process.stdout.write('cmux not available; falling back to single-terminal dev\n')
  }

  const runner = await run(options)

  // In-process backends share this event loop; a handler's escaped async path would otherwise terminate
  // the whole session. Installed only on the single-process path (the cmux path returned above, each pane
  // being its own process) and only after `run()` succeeds, so a boot failure still exits honestly.
  //
  // `onFault` is not optional decoration. The dev-server owns `process.stderr` for the life of a TTY
  // session (every log line goes to a per-service file, nothing prints), and the barrier's default
  // reporter is a plain stderr write — so a crash would be silently FILED while the panel kept showing
  // `● ok` and `⚠ 0`. Routing it through the runner both counts it (the row turns red) and punches it
  // onto the terminal through the panel's bypass.
  registerCrashBarrier({
    onFault: (event, error) => {
      runner.reportFault(formatFault(event, error))
    },
  })

  registerSignalShutdown({
    onSignal: async (signal) => {
      // Bypass, not `process.stdout.write`: the interceptor is still installed and suppressing at this
      // point, so a plain write would file this into a log and the user would see nothing after Ctrl-C.
      rawStdoutWrite(`\nReceived ${signal}, shutting down dev-server...\n`)
      await runner.shutdown()
    },
  })
}

/**
 * True when `infra-kit dev` was invoked BARE — no preset and no selection/mode flag — in an interactive
 * TTY (both stdin and stdout) and not `--json`. This is the ONLY condition that launches the wizard;
 * every flagged, piped, non-TTY, `--json`, or MCP invocation runs directly from the parsed flags, so no
 * existing script path changes behaviour.
 */
export const shouldRunWizard = (raw: DevCliOptions, tty: boolean, json: boolean): boolean => {
  const bare = !raw.preset && !raw.app && !raw.self && !raw.cmux && !raw.watch && !raw.verbose && !raw.routes

  return bare && tty && !json
}

/** Map a wizard result to runner options: the cmux path uses `include`; otherwise the in-memory `presetDef`. */
const wizardToOptions = (result: WizardResult): DevServerOptions => {
  return {
    watch: result.watch,
    cmux: result.cmux,
    include: result.include ?? null,
    preset: result.preset,
    presetDef: result.presetDef,
    self: false,
    verbose: false,
    routes: false,
  }
}

/**
 * Entry for the `infra-kit dev` subcommand. On a bare TTY invocation it launches the interactive wizard
 * (lazily imported so its inquirer/config graph stays off every other path), then starts the server with
 * the assembled options; otherwise it runs directly from the parsed flags. A cancelled prompt (Ctrl-C /
 * Esc) or an empty selection exits cleanly without starting a server.
 */
export const runDevServerCli = async (raw: DevCliOptions, tty: boolean, json: boolean): Promise<void> => {
  if (shouldRunWizard(raw, tty, json)) {
    const { runDevWizard } = await import('src/dev/dev-wizard-run')

    // Warm the Ink dev-UI chunks BEFORE the wizard blocks on human input.
    //
    // `splitting: true` emits these as CONTENT-HASHED sibling chunks, and `selectDevUi` imports them only
    // AFTER the wizard returns (src/dev/dev-server.ts). That leaves a window as long as the user takes to
    // answer — minutes, realistically — in which those files are still un-imported. If the background
    // auto-updater installs a new version during it, npm UNLINKS the old hashes (measured: 7 chunk files
    // vanished across a real 0.1.133 → 0.1.134 install), and the deferred import dies on
    // ERR_MODULE_NOT_FOUND the instant the user presses enter.
    //
    // Importing them up-front collapses that window to nothing: ESM caches by URL, so `selectDevUi`'s
    // later import resolves from memory even if the file is gone by then. This is a warm, not a use —
    // failure is ignored, because `selectDevUi` will import them again and surface any real error there.
    // Costs nothing on any other path: it runs only on the bare interactive TTY that is about to load
    // this exact UI anyway.
    const warmed = Promise.all([import('src/tui/dev-ui/persistent-ink-dev-ui'), import('src/tui/safe-stderr')]).catch(
      () => {
        return undefined
      },
    )

    let result: WizardResult | null

    try {
      result = await runDevWizard()
    } catch (error) {
      if (isPromptCancellation(error)) return

      throw error
    }

    if (result == null) return

    // Settle the warm before starting: from here on the chunks are resident, so a `dist/` swap mid-session
    // can no longer strand the deferred import in `selectDevUi`.
    await warmed

    // The wizard only runs on a bare interactive TTY, so tty=true, json=false — thread them so `run()`
    // selects the Ink boot UI.
    await runDevServer({ ...wizardToOptions(result), tty, json })

    return
  }

  // Thread the TTY / json signal so `run()` can pick the Ink boot UI (TTY, non-json) vs the plain renderer.
  await runDevServer({ ...toDevServerOptions(raw), tty, json })
}

/** Parse `node dist/dev-server.js ...` flags and start the server. */
const parseAndRun = async (argv: string[]): Promise<void> => {
  const program = new Command()

  program
    .name('infra-kit-dev-server')
    .description('Run local dev servers for the apps in a named devServersPresets preset (or all apps)')
    .argument('[preset]', 'Named preset from devServersPresets (omit to run every app)')
    .option('-w, --watch', 'Rebuild and restart on file save')
    .option('--app <names>', 'Further narrow to these app folder names (comma-separated)')
    .option(
      '--cmux',
      'Run each app in its own cmux pane (one workspace, N panes; falls back to single terminal if cmux is unavailable)',
    )
    .option('--self', 'Run only the app of the current directory (infer from cwd; use inside apps/<app>/…)')
    .option('-V, --verbose', 'Print full boot narration (default: quiet; full detail always in the session log)')
    .option('--routes', 'Print each app’s registered METHOD /path routes at startup (default: off)')

  program.parse(argv)

  await runDevServer(toDevServerOptions({ ...program.opts<DevCliOptions>(), preset: program.args[0] }))
}

// Self-execute only when run directly (`node dist/dev-server.js`), not when the
// `infra-kit dev` subcommand imports this module for its exported helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  parseAndRun(process.argv).catch((error: unknown) => {
    // Message only, matching the `infra-kit dev` path: a bad preset name or target key is a
    // config mistake, and its stack frames are noise.
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
