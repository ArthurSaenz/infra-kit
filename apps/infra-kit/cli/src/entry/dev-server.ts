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
import type { DevServerOptions, DevServerRunner } from 'src/dev/dev-server'
import type { WizardResult } from 'src/dev/dev-wizard-run'
import { resolveSelfAppName } from 'src/dev/discovery'
import { rawStdoutWrite } from 'src/dev/log-sink'
import { killDescendantGroupsNow } from 'src/dev/managed-child'
import { explainTargetKey } from 'src/dev/presets'
import { exitCodeForSignal, registerSignalShutdown } from 'src/dev/signal-shutdown'
import { installTerminalLiveness } from 'src/dev/terminal-liveness'
import { isCmuxAvailable } from 'src/integrations/cmux'
import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import type { DevPreset } from 'src/lib/infra-kit-config'

/**
 * Exit code when the session dies because its own stdio is unwritable. Not 0 — the process did not stop
 * voluntarily — and not `128 + signo`, because no signal was necessarily involved: a full disk under
 * `nohup ik dev > out.log` reaches this path with `ENOSPC` and nobody sent anything.
 */
const FATAL_EXIT_CODE = 1

/**
 * How long the fatal path waits for a graceful teardown before SIGKILLing the descendant groups and
 * leaving. Mirrors `signal-shutdown`'s deadline, and for the same reason: on this path there is by
 * definition no operator watching, so "wait forever" means "spin forever".
 */
const FATAL_TEARDOWN_DEADLINE_MS = 20_000

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
  /**
   * Commander's negated flag: `true` by default, `false` only when `--no-ui-health` was passed. Off means
   * the frontends are never probed and their rows carry no health dot.
   */
  uiHealth?: boolean
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
    uiHealth: raw.uiHealth ?? true,
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
 * Seams for {@link createFatalHandler}. `exit` and `forceReap` mirror `signal-shutdown`'s, and for the same
 * reason: the real ones kill the test runner and SIGKILL its children.
 */
export interface FatalHandlerDeps {
  /**
   * The runner — read LATE, on every call, never captured. It is `null` for the whole of boot (all of it
   * happens inside `run()`), and that is the branch the handler exists to get right.
   */
  getRunner: () => { shutdown: () => Promise<void>; fileFault: (detail: string) => void } | null
  /** SIGKILL the descendant process groups. Synchronous by contract — the process exits on the next line. */
  forceReap?: () => void
  exit?: (code: number) => void
  /** Timer seam returning its cancel; defaults to an `unref`'d `setTimeout`. */
  setTimer?: (handler: () => void, ms: number) => () => void
  deadlineMs?: number
}

const defaultFatalTimer = (handler: () => void, ms: number): (() => void) => {
  const timer = setTimeout(handler, ms)

  timer.unref()

  return (): void => {
    clearTimeout(timer)
  }
}

/**
 * A `setTimer` seam SHARED by two independent watchdogs racing the same `boundRunner.shutdown()` call:
 * `signal-shutdown`'s teardown deadline and {@link createFatalHandler}'s fatal deadline.
 *
 * Whichever caller arms first OWNS the timer; a second `setTimer` call while one is still pending is a
 * no-op — its returned canceller does nothing, because there is nothing THIS call armed to cancel.
 * Releasing ownership (teardown completed, or the second-signal escape fired) lets a later, genuinely
 * independent event arm its own timer again.
 */
// Both watchdogs exist for the identical reason — force-exit a wedged teardown when nobody is watching —
// and a closed terminal can arm BOTH of them for the SAME shutdown: the kernel delivers SIGHUP first,
// `registerSignalShutdown`'s `onSignal` writes through `rawStdoutWrite` as its very first act, and THAT
// write is what produces the stdio `'error'` `terminal-liveness` reports through `onFatal` a tick later.
// `shutdown()` is memoized (see `src/dev/dev-server.ts`), so both deadlines would otherwise count down
// against the exact same in-flight promise — and a wedge would then exit with whichever code's 20s timer
// happened to fire first (129 vs the fatal path's fixed `1`), a coin-flip instead of the honest signal
// code.
export const createSharedDeadlineTimer = (
  setTimer: (handler: () => void, ms: number) => () => void = defaultFatalTimer,
): ((handler: () => void, ms: number) => () => void) => {
  let armed = false

  return (handler, ms) => {
    if (armed) {
      return (): void => {}
    }

    armed = true

    const cancel = setTimer(handler, ms)

    return (): void => {
      armed = false
      cancel()
    }
  }
}

/**
 * Reap the descendant process groups and exit with `code`, synchronously — the shared shape of
 * every "there is no runner to hand a graceful teardown to" exit: {@link createFatalHandler}'s
 * `runner == null` branch, and {@link installBootSignalGuard} below. Pulled out so the two stay
 * identical on purpose, rather than two hand-copies that can quietly drift apart.
 */
const reapAndExit = (forceReap: () => void, exit: (code: number) => void, code: number): void => {
  forceReap()
  exit(code)
}

/**
 * The one handler for "our own stdio is unwritable" — from the liveness listener (with the errno) and, as a
 * backstop, from the crash barrier.
 *
 * Once-only. Terminal death is ONE event arriving through as many as three channels (the stdio `'error'`
 * event, the kernel's SIGHUP, a fault raised while the streams are already dead). `shutdown()` is memoized
 * so they may all call it; the reap-and-exit here must still happen exactly once.
 *
 * It never PRINTS: printing onto a dead stream is what produced the fault, so the report is FILED into the
 * sink — the only channel a post-mortem can still read. With no runner yet, it reaps and exits.
 */
// The `runner == null` branch is not a corner case, it is a REGRESSION GUARD. Today an EIO during boot
// correctly kills the process (the barrier is not installed yet). A liveness listener that merely
// swallowed the `'error'` would make boot silently survive a dead terminal — strictly worse. That branch
// reaps and exits SYNCHRONOUSLY: anything deferred to a later tick does not survive `process.exit`.
export const createFatalHandler = ({
  getRunner,
  forceReap = killDescendantGroupsNow,
  exit = (code: number): void => {
    process.exit(code)
  },
  setTimer = defaultFatalTimer,
  deadlineMs = FATAL_TEARDOWN_DEADLINE_MS,
}: FatalHandlerDeps): ((reason: string) => void) => {
  let fired = false

  return (reason: string): void => {
    if (fired) return
    fired = true

    const runner = getRunner()

    if (runner == null) {
      reapAndExit(forceReap, exit, FATAL_EXIT_CODE)

      return
    }

    runner.fileFault(`\n✗ dev-server exiting: ${reason}\n`)

    // Bounded, for the same reason `signal-shutdown` is: on this path nobody is watching, so a teardown
    // that wedges spins forever.
    const cancel = setTimer(() => {
      forceReap()
      exit(FATAL_EXIT_CODE)
    }, deadlineMs)

    // The trailing `.catch` is NOT redundant with `shutdown()`'s own. `shutdown()` attaches its handler to
    // the memoized `this.teardown`; `.finally()` returns a NEW, derived promise, and a derived promise
    // carries its own rejection state. `doShutdown()` can reject (`watcher.close`, `turboWatch.kill` and
    // `uiDev.kill` are unguarded), so without this the derived promise rejects unhandled — on the one path
    // where an `unhandledRejection` feeds straight back into the barrier that called us.
    runner
      .shutdown()
      .finally(() => {
        cancel()
        exit(FATAL_EXIT_CODE)
      })
      .catch(() => {})
  }
}

/** The signals guarded during boot. Matches `signal-shutdown`'s SIGINT/SIGTERM, minus SIGHUP: this guard
 * exists only for the window before a runner exists, and is gone (see {@link installBootSignalGuard}'s
 * doc block) by the time `registerSignalShutdown` — which does own SIGHUP — takes over. */
const BOOT_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/**
 * Seams for {@link installBootSignalGuard}. `register`/`unregister` default to `process.on`/`process.off`;
 * a test either fakes them (to exercise the guard without touching real process listeners) or leaves them
 * real (to assert `remove()` actually drops the listener count it added).
 */
export interface BootSignalGuardDeps {
  forceReap?: () => void
  exit?: (code: number) => void
  register?: (signal: NodeJS.Signals, handler: () => void) => void
  unregister?: (signal: NodeJS.Signals, handler: () => void) => void
}

/** Live handle returned by {@link installBootSignalGuard}. */
export interface BootSignalGuard {
  /** Detach both listeners. The caller invokes this exactly once, from a `finally` around `run()`. */
  remove: () => void
}

/**
 * Arm a minimal SIGINT/SIGTERM handler for the boot window — the stretch from process start until
 * `runner = await run(options)` resolves, during which a cold `turbo` build can run for minutes.
 *
 * Reap-and-exit only, via the same {@link reapAndExit} shape the fatal handler's boot branch uses; there
 * is no teardown to await, because there is no runner. The exit code is the conventional `128 + signo`
 * ({@link exitCodeForSignal}).
 *
 * The caller MUST call `remove()` once `run()` settles, in both directions.
 */
// Why arm anything at all with no runner: Node's default SIGINT/SIGTERM action is an unconditional
// terminate, which skips `killDescendantGroupsNow` entirely and orphans whatever turbo/vite process groups
// boot has already spawned. Precedent for arming protection this early already exists:
// `installTerminalLiveness` and the fatal handler's `runner == null` branch both guard the same window.
//
// Why `128 + signo` and not the fatal path's fixed `FATAL_EXIT_CODE`: that code names a different failure
// (our own stdio died), not "the user hit Ctrl-C during a slow build". This matches `signal-shutdown`'s
// contract for a genuine SIGINT/SIGTERM.
//
// Why `remove()` is mandatory in BOTH directions: on success `registerSignalShutdown` takes over
// SIGINT/SIGTERM (plus SIGHUP) for the rest of the session, and leaving this guard attached too would fire
// BOTH handlers on every subsequent signal; on a boot failure there is no runner left to protect.
export const installBootSignalGuard = ({
  forceReap = killDescendantGroupsNow,
  exit = (code: number): void => {
    process.exit(code)
  },
  register = (signal, handler): void => {
    process.on(signal, handler)
  },
  unregister = (signal, handler): void => {
    process.off(signal, handler)
  },
}: BootSignalGuardDeps = {}): BootSignalGuard => {
  const handlers = new Map<NodeJS.Signals, () => void>()

  for (const signal of BOOT_SIGNALS) {
    const handler = (): void => {
      reapAndExit(forceReap, exit, exitCodeForSignal(signal))
    }

    handlers.set(signal, handler)
    register(signal, handler)
  }

  return {
    remove: (): void => {
      for (const [signal, handler] of handlers) {
        unregister(signal, handler)
      }
    },
  }
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

  // A settable target, not a `const`: liveness must be armed BEFORE `run()`, because all of boot happens
  // inside it (apps built, turbo and vite spawned, Ink mounted) — minutes of build during which a developer
  // walks away and closes the window. But `onDeath` can then fire with no runner to tear down, so the fatal
  // handler branches on it (and reads it LATE, through the getter).
  //
  // Installed HERE — below the `--cmux` early return above, alongside `registerCrashBarrier`, which is
  // deliberately on the same side of it (each pane is its own process). At the top of `runDevServer` the
  // cmux PARENT would get a listener whose `runner` stays `null` forever, and its `onFatal` would take the
  // boot branch: `killDescendantGroupsNow()` + exit, reaping the entire workspace.
  let runner: DevServerRunner | null = null

  // Shared with `registerSignalShutdown` below — see `createSharedDeadlineTimer`'s doc block for why
  // one instance must back BOTH watchdogs' deadlines rather than each arming its own.
  const sharedDeadlineTimer = createSharedDeadlineTimer()

  const onFatal = createFatalHandler({
    getRunner: () => {
      return runner
    },
    setTimer: sharedDeadlineTimer,
  })

  const liveness = installTerminalLiveness({
    // The errno, never a story. A file-backed stdout emits `'error'` on `ENOSPC` too, so "the terminal is
    // gone" would be a lie in the exact scenario (a disk-fill) this exists to fix.
    onDeath: (stream, error) => {
      onFatal(`stdio unwritable: ${stream} ${error.code}`)
    },
  })

  // Same boot window as `liveness` above, same reason: `run()` can spend minutes in a cold `turbo`
  // build, and Node's default SIGINT/SIGTERM action would terminate immediately without reaping the
  // turbo/vite groups already spawned mid-boot. Always removed once `run()` settles — on success,
  // `registerSignalShutdown` below takes over SIGINT/SIGTERM (plus SIGHUP) for the rest of the session; on
  // a boot failure there is no runner left for this guard to protect either.
  const bootSignalGuard = installBootSignalGuard()

  try {
    runner = await run({
      ...options,
      // The runner tears itself down but cannot END the process: `doShutdown` has no `process.exit`, and
      // the reload-budget stop reaches neither the signal handler nor the fatal one. Left unwired it
      // would hand the user a live terminal with every server already dead. Same destination as every
      // other exit here — `process.exit` — so a budget stop and a Ctrl-C finish the same way.
      onExitRequest: (code: number): void => {
        process.exit(code)
      },
    })
  } finally {
    bootSignalGuard.remove()
  }

  // In-process backends share this event loop; a handler's escaped async path would otherwise terminate
  // the whole session. Installed only on the single-process path (the cmux path returned above, each pane
  // being its own process) and only after `run()` succeeds, so a boot failure still exits honestly.
  //
  // `onFault` is not optional decoration. The dev-server owns `process.stderr` for the life of a TTY
  // session (every log line goes to a per-service file, nothing prints), and the barrier's default
  // reporter is a plain stderr write — so a crash would be silently FILED while the panel kept showing
  // `● ok` and `⚠ 0`. Routing it through the runner both counts it (the row turns red) and punches it
  // onto the terminal through the panel's bypass.
  //
  // `isTerminalDead` is the one thing that may turn a fault fatal, and it is a STREAM-IDENTITY question,
  // never an error-code one: a handler writing to a client socket that hung up throws `EPIPE` too, and
  // sniffing for that would let one closed browser tab kill the whole session.
  const boundRunner = runner

  registerCrashBarrier({
    onFault: (event, error) => {
      boundRunner.reportFault(formatFault(event, error))
    },
    isTerminalDead: liveness.isDead,
    fileFault: (event, error) => {
      boundRunner.fileFault(formatFault(event, error, false))
    },
    onFatal,
  })

  registerSignalShutdown({
    onSignal: async (signal) => {
      // Bypass, not `process.stdout.write`: the interceptor is still installed and suppressing at this
      // point, so a plain write would file this into a log and the user would see nothing after Ctrl-C.
      // Gated on the liveness latch, so a SIGHUP from a terminal that is already gone does not re-arm the
      // very write that killed it.
      rawStdoutWrite(`\nReceived ${signal}, shutting down dev-server...\n`)
      await boundRunner.shutdown()
    },
    // The seam that turns the deadline from a blunt force-quit into the instrument that says WHERE the
    // teardown wedged — the question the incident leaves open.
    describeStall: () => {
      return boundRunner.shutdownStage
    },
    fileReport: (text) => {
      boundRunner.fileFault(text)
    },
    setTimer: sharedDeadlineTimer,
  })
}

/**
 * True when `infra-kit dev` was invoked BARE — no preset and no selection/mode flag — in an interactive
 * TTY (both stdin and stdout) and not `--json`. This is the ONLY condition that launches the wizard;
 * every flagged, piped, non-TTY, `--json`, or MCP invocation runs directly from the parsed flags, so no
 * existing script path changes behaviour.
 */
export const shouldRunWizard = (raw: DevCliOptions, tty: boolean, json: boolean): boolean => {
  // `--no-ui-health` is deliberately NOT in this list. It selects a diagnostic, not a run plan, and a flag
  // that quietly turns the picker into "run the entire repo" is a far bigger surprise than the one it would
  // avoid. The wizard carries it through instead (see `wizardToOptions`), so the user gets both.
  const bare = !raw.preset && !raw.app && !raw.self && !raw.cmux && !raw.watch && !raw.verbose && !raw.routes

  return bare && tty && !json
}

/** Map a wizard result to runner options: the cmux path uses `include`; otherwise the in-memory `presetDef`. */
const wizardToOptions = (result: WizardResult, raw: DevCliOptions): DevServerOptions => {
  return {
    watch: result.watch,
    cmux: result.cmux,
    include: result.include ?? null,
    preset: result.preset,
    presetDef: result.presetDef,
    self: false,
    verbose: false,
    routes: false,
    // The wizard asks about the run plan, never about health — so this rides through from the command line.
    // Dropping it here is what would make `--no-ui-health` silently probe anyway on the one path that
    // reaches the wizard.
    uiHealth: raw.uiHealth ?? true,
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
    await runDevServer({ ...wizardToOptions(result, raw), tty, json })

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
