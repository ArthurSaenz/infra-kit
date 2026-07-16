import { chalkStderr } from 'chalk'
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import process from 'node:process'

import { equivalentLine } from './equivalent'
import { formatRunHeader, formatTranscriptEntry } from './format-entry'
import { classifyOutcome } from './outcome'
import { SESSION_REPORT_ENV, newReportPath, readAndUnlinkReport } from './report'
import { resetTerminal } from './reset-terminal'

/**
 * The persistent `infra-kit` session shell (React-free so it stays out of the eager Ink chunk and is
 * unit-testable with plain vitest). Each iteration: render the palette → echo the command → spawn it
 * as a fresh child that inherits this terminal → reap → read the child's report file → commit one
 * status footer → repeat, until the palette returns `null` (quit).
 *
 * The child runs on the PRIMARY screen, exactly as if the user had typed the command. That is the
 * whole point: its output stays in the scrollback, framed by the echoed `$ infra-kit …` header above
 * and the status footer below. (Children used to run inside the alternate screen buffer, which the
 * terminal discards on exit — so every command appeared to produce no output at all.)
 *
 * The child boundary is what makes this safe: a `process.exit` in a command exits the child, not the
 * loop; a fresh process means fresh Commander/option state; and the child owns stdin via inherited
 * stdio, so the parent adds zero contention. The session exit code is always 0 — per-command results
 * live in the transcript, not the shell's exit status.
 */

/** A menu-selectable command resolved from the catalog: what to spawn and how to present it. */
export interface SessionCommand {
  /** Canonical Commander argv, e.g. `['vendor', 'check']`. */
  groupPath: string[]
  /**
   * The command hands the terminal to a full-screen child that enters the alternate screen itself (an
   * `$EDITOR`). We never enter it for them — but if that child is killed before it restores the
   * primary buffer, every later frame would be drawn into an abandoned buffer, so the hygiene reset
   * leaves the alternate screen defensively on their behalf.
   */
  entersAltScreen?: boolean
  /** Append the "applies after you exit" notice (env-load/clear can't mutate the parent shell). */
  sessionEnvNotice?: boolean
  /**
   * Runs until the user stops it (`dev`). It writes no report (its action resolves at boot, long before
   * it is done) and exits `128 + signo` on a Ctrl-C rather than dying by the signal, so `classifyOutcome`
   * needs to be told — otherwise every normal stop reads as a failure.
   */
  longRunning?: boolean
}

/** A palette row — structurally compatible with the Ink palette's `PaletteItem`, no React dependency. */
export interface SessionPaletteItem {
  name: string
  description: string
  group: string
}

export interface RunSessionDeps {
  /** Render the palette and resolve to the picked flat command name, or `null` to quit the session. */
  renderPalette: (items: SessionPaletteItem[]) => Promise<string | null>
  /** Map a picked flat name to its spawn/presentation info (from the command catalog). */
  resolveCommand: (name: string) => SessionCommand | undefined
  /** Absolute path to this bundle's `cli.js`, spawned as `process.execPath <cliPath> <...groupPath>`. */
  cliPath: string
  spawn?: typeof nodeSpawn
  now?: () => number
  /** Commit a finished transcript entry (default: stderr, consistent with all repo human output). */
  write?: (text: string) => void
  env?: NodeJS.ProcessEnv
  /** ASCII glyphs for the transcript (default: derived from stdout TTY / TERM). */
  ascii?: boolean
  /** Colour the header and footer (default: chalk's own TTY / `NO_COLOR` / `FORCE_COLOR` verdict). */
  color?: boolean
  /**
   * Terminal width for the footer's closing rule, or `undefined` for none (default: stderr's columns —
   * the stream the transcript is written to).
   *
   * A FUNCTION, not a number, because the session shell is long-lived: it loops until the user quits, so
   * a width snapshotted at boot goes stale the moment they resize the window. Re-read per run, a shrink
   * just makes the next rule shorter; snapshotted, it would overrun the new margin and wrap across
   * rows — the exact wall-of-text this framing exists to prevent.
   */
  columns?: () => number | undefined
  /** Terminal hygiene after each child (default: the real escapes; tests inject a spy). */
  resetTerminal?: (opts: { entersAltScreen?: boolean }) => void
  /** Install the real signal handlers (default true; tests pass false to stay signal-free). */
  installSignals?: boolean
  /** Process seams for those handlers (default: the real `process`). Tests inject fakes to assert policy. */
  signals?: SessionSignalDeps
}

/** The replayable command line for a pick — echoed as the header, and the default equivalent line. */
const commandLine = (command: SessionCommand): string => {
  return `infra-kit ${command.groupPath.join(' ')}`
}

/**
 * The width of the stream the transcript is written to, or `undefined` when it has none.
 *
 * Node types `columns` as a `number`, but a non-TTY stderr has no such property at all. Passing the
 * resulting `undefined` (or a `0`) through as a width would read to the formatter as a *very narrow*
 * terminal; `undefined` is the value that means "draw no rule", so normalise to it explicitly.
 */
const stderrColumns = (): number | undefined => {
  const columns: number | undefined = process.stderr.columns

  return columns != null && columns > 0 ? columns : undefined
}

const waitForExit = (child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal })
    })
    child.on('error', () => {
      // A spawn that never launched is a failed run, not a cancel.
      resolve({ code: 1, signal: null })
    })
  })
}

/** Every dep `runOne` needs, with the defaults already applied. */
type ResolvedDeps = Required<
  Pick<RunSessionDeps, 'spawn' | 'now' | 'env' | 'cliPath' | 'ascii' | 'color' | 'columns' | 'resetTerminal'>
>

/**
 * Run one picked command as a child on THIS terminal and format the footer that closes it out. The
 * header is echoed by the caller before we spawn, so the child's output arrives under a heading.
 */
const runOne = async (
  command: SessionCommand,
  deps: ResolvedDeps,
  markChildOwnsSigint: () => void,
): Promise<string> => {
  const reportPath = newReportPath()
  const childEnv: NodeJS.ProcessEnv = {
    ...deps.env,
    [SESSION_REPORT_ENV]: reportPath,
    // Every child would otherwise re-run the throttled auto-update check and spawn its own detached
    // worker; opt them all out. The parent's own startup check (before the palette) still runs.
    INFRA_KIT_NO_AUTO_UPDATE: '1',
  }
  const start = deps.now()

  let result: { code: number | null; signal: NodeJS.Signals | null } = { code: 1, signal: null }

  markChildOwnsSigint()
  try {
    // `stdio: 'inherit'` on the primary screen: the child writes straight to the user's terminal, so
    // its output lands in the scrollback and stays there. Never pipe — a piped child loses its TTY,
    // which strips colour and breaks every interactive prompt (release-create, the branch pickers).
    const child = deps.spawn(process.execPath, [deps.cliPath, ...command.groupPath], {
      stdio: 'inherit',
      env: childEnv,
    })

    result = await waitForExit(child)
  } catch {
    // A synchronous spawn throw (or a rejected run) must degrade to a `failed` transcript entry, never
    // tear the session down.
    result = { code: 1, signal: null }
  } finally {
    // NOT the place to hand SIGINT back. The child's `exit` has fired, but the terminal reset below, the
    // report read, and the footer + palette draw are all still ahead — and a user force-quitting the child
    // MASHES Ctrl-C, so more SIGINTs are still landing. Clearing the flag here made every one of them take
    // the "no child running" branch and `exit(0)` the WHOLE SESSION SHELL instead of returning to the
    // palette. The loop clears it immediately before `renderPalette`, once the palette can own Ctrl-C.
    deps.resetTerminal({ entersAltScreen: command.entersAltScreen })
  }

  const record = readAndUnlinkReport(reportPath)
  const outcome = classifyOutcome(result.code, result.signal, record != null, command.longRunning)
  const headerLine = commandLine(command)
  const equivalent = record?.equivalent ?? equivalentLine(headerLine, true)

  return formatTranscriptEntry({
    equivalent,
    outcome,
    durationMs: deps.now() - start,
    summary: record?.summary,
    envNotice: command.sessionEnvNotice,
    ascii: deps.ascii,
    color: deps.color,
    // Read HERE, not at session boot: the user may have resized the window since the last run.
    width: deps.columns(),
    // We already echoed this line before the spawn. Repeat it only when the child reported back a
    // DIFFERENT one — an interactive command folding its resolved flags into a replayable `≈` line.
    showEquivalent: !(equivalent.reproducible && equivalent.line === headerLine),
  })
}

/** Process-level seams for the signal owners (tests inject fakes; production wires `process`). */
export interface SessionSignalDeps {
  register: (signal: NodeJS.Signals, handler: () => void) => void
  unregister: (signal: NodeJS.Signals, handler: () => void) => void
  exit: (code: number) => void
  /** Deliver a signal to THIS process (used to take SIGTSTP's default action: stop). */
  raise: (signal: NodeJS.Signals) => void
  /**
   * Terminal hygiene on the way out of a between-iterations exit, where the PALETTE — not a child —
   * owns the screen. Ink is mid-render there: raw mode armed, cursor hidden, a frame on screen. An
   * `exit()` from a signal handler runs none of Ink's teardown, so without this the user's shell comes
   * back to a hidden cursor, a stranded frame and a tty that eats their keystrokes.
   *
   * Required, not optional: a silent default would hand a fake `signals` the real escapes and spray
   * them through the test reporter, which is precisely the accident this seam exists to prevent.
   */
  resetTerminal: () => void
}

/** The session's live signal owner: handler teardown, plus the state the loop must consult. */
export interface SessionSignals {
  /** Remove every installed handler. */
  dispose: () => void
  /** Call when a child is about to run — resets the per-child signal history. */
  childStarted: () => void
  /** True when an external SIGTERM asked us to stop; the loop must exit after the current child. */
  quitRequested: () => boolean
}

/**
 * Install the session's state-aware signal owners. The child is spawned WITHOUT `detached`, so it shares
 * this process's group — every tty-delivered signal reaches the child directly, and the parent's job is
 * only to decide what IT does.
 *
 * - **SIGINT** — swallowed while a child runs, so the tty's Ctrl-C stops only the child and the parent
 *   survives to render `⊘ cancelled` and loop. Between iterations it ends the session (exit 0).
 * - **SIGTERM** — DEFERRED, not dropped, while a child runs: we finish the child, commit its transcript
 *   entry, and then end the session. Dropping it outright would make the session unkillable by anything
 *   short of SIGKILL for as long as a child ran — and `dev` runs for hours.
 *
 *   The exception is pnpm's RELAY. Under `pnpm exec infra-kit`, pnpm forwards a SIGTERM to us moments
 *   after the tty's Ctrl-C — that SIGTERM is an artifact of the SIGINT the user already aimed at the
 *   child, not a request to kill the session, so a SIGTERM that FOLLOWS a SIGINT within the same child
 *   is swallowed. (Causality, not a timing heuristic: the relay only exists because of the Ctrl-C.)
 *   Without a handler at all, that relay was an instant unhandled parent death — the shell prompt
 *   returned while the child still owned the tty and wrote teardown output over it.
 * - **SIGHUP** — NEVER swallowed. It means the terminal is gone, so staying alive would leave the
 *   session looping on a dead tty, drawing palette frames into a closed fd. Always exit (129). The child
 *   gets its own SIGHUP and is responsible for its own reap (see `dev/signal-shutdown.ts`).
 * - **SIGTSTP** — Ctrl-Z. While a child runs we STOP OURSELVES, because the tty already delivered
 *   SIGTSTP to the whole foreground group: the child has stopped, and if the parent merely ignored the
 *   signal (as it used to) it would sit in `waitForExit` awaiting an exit that can never come, wedging
 *   the terminal with no prompt and no way back. Stopping too suspends the FOREGROUND GROUP as a unit,
 *   so the user's shell reclaims the tty and prints a prompt; `fg` sends SIGCONT to the group and both
 *   resume. Handlers survive stop/continue, so there is nothing to re-arm.
 *
 *   CAVEAT — a child's own DETACHED descendants keep running: `dev`'s turbo/vite children sit in their
 *   own process groups, so a Ctrl-Z out of `dev` suspends `dev` itself while its servers stay up and
 *   bound to their ports. Recoverable with `fg`, and strictly better than the wedge it replaced, but
 *   "suspended" is not the whole truth for `dev`. Between iterations SIGTSTP stays IGNORED: suspending
 *   mid-palette would strand a half-drawn Ink frame on the screen.
 */
export const installSessionSignals = (isChildRunning: () => boolean, deps: SessionSignalDeps): SessionSignals => {
  // Per-child signal history: a SIGTERM is pnpm's relay only if a SIGINT preceded it for THIS child.
  let sigintSeenDuringChild = false
  let quitRequested = false

  const onSigint = (): void => {
    if (isChildRunning()) {
      // The child got its own copy from the tty; ours only records that the Ctrl-C happened, so a
      // SIGTERM arriving next can be recognised as pnpm's relay rather than an external kill.
      sigintSeenDuringChild = true

      return
    }

    // The palette owns the screen here, and this exit skips Ink's teardown entirely — see
    // `resetTerminal` on SessionSignalDeps.
    deps.resetTerminal()
    deps.exit(0)
  }
  const onSigterm = (): void => {
    if (!isChildRunning()) {
      // Same window, same reason as SIGINT above: an external `kill` can land mid-palette.
      deps.resetTerminal()
      deps.exit(0)

      return
    }

    if (sigintSeenDuringChild) {
      // pnpm's relay of the Ctrl-C the user aimed at the child. Not a request to end the session.
      return
    }

    // A genuine external `kill`. Let the child finish and its entry commit, then stop.
    quitRequested = true
  }
  const onSighup = (): void => {
    // The tty is gone. There is nothing left to render into and no user to render for.
    deps.exit(129)
  }
  const onSigtstp = (): void => {
    if (!isChildRunning()) {
      // Mid-palette: ignore, or we would suspend with a partial frame committed to the screen.
      return
    }

    // SIGSTOP cannot be caught — this takes the default action the handler is suppressing.
    deps.raise('SIGSTOP')
  }

  deps.register('SIGINT', onSigint)
  deps.register('SIGTERM', onSigterm)
  deps.register('SIGHUP', onSighup)
  deps.register('SIGTSTP', onSigtstp)

  return {
    dispose: () => {
      deps.unregister('SIGINT', onSigint)
      deps.unregister('SIGTERM', onSigterm)
      deps.unregister('SIGHUP', onSighup)
      deps.unregister('SIGTSTP', onSigtstp)
    },
    childStarted: () => {
      sigintSeenDuringChild = false
    },
    quitRequested: () => {
      return quitRequested
    },
  }
}

/**
 * Pure gate: may bare `infra-kit` engage the persistent session shell? Requires an interactive TTY on
 * all three streams, a capable terminal, and no opt-out. Deliberately does NOT depend on
 * `INFRA_KIT_SESSION` (the shell must work without `infra-kit init` having run). Everything else keeps
 * the one-shot path.
 *
 * **stderr is load-bearing**, not an afterthought: the palette and every transcript line are written
 * there. Under `infra-kit 2>out.log` the palette would be invisible (it renders into the file), and
 * writes to a pipe are asynchronous on macOS — so the echoed header could land AFTER the child's
 * output, which is the one ordering the shell guarantees. Both are avoided by never entering the shell
 * when stderr is redirected.
 *
 * @example
 * sessionGateEnabled({ TERM: 'xterm' }, { stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true }) // => true
 */
export const sessionGateEnabled = (
  env: NodeJS.ProcessEnv,
  streams: { stdoutIsTTY: boolean; stdinIsTTY: boolean; stderrIsTTY: boolean },
): boolean => {
  return Boolean(
    streams.stdoutIsTTY &&
    streams.stdinIsTTY &&
    streams.stderrIsTTY &&
    env.TERM !== 'dumb' &&
    !env.INFRA_KIT_NO_SESSION &&
    !env.INFRA_KIT_SESSION_REPORT,
  )
}

/**
 * Run the session loop until the user quits at the palette.
 *
 * @example
 * await runSession(items, { renderPalette, resolveCommand, cliPath: '/g/dist/cli.js' })
 */
export const runSession = async (items: SessionPaletteItem[], deps: RunSessionDeps): Promise<void> => {
  const resolved = {
    spawn: deps.spawn ?? nodeSpawn,
    now:
      deps.now ??
      (() => {
        return Date.now()
      }),
    env: deps.env ?? process.env,
    cliPath: deps.cliPath,
    ascii: deps.ascii ?? !(process.stdout.isTTY && process.env.TERM !== 'dumb'),
    // `chalkStderr`, not `chalk`: the default instance sniffs STDOUT, and every byte of the transcript
    // goes to stderr (see `write` below). It already folds in TTY detection, `NO_COLOR` and
    // `FORCE_COLOR`. The formatter itself is colour-pure, so this is the only place the call is made —
    // and it is made against the same stream `columns` is read from.
    color: deps.color ?? chalkStderr.level > 0,
    columns: deps.columns ?? stderrColumns,
    resetTerminal:
      deps.resetTerminal ??
      ((opts: { entersAltScreen?: boolean }) => {
        resetTerminal(opts)
      }),
  }
  const write =
    deps.write ??
    ((text: string) => {
      return process.stderr.write(text)
    })

  const signals: SessionSignalDeps = deps.signals ?? {
    register: (signal, handler) => {
      process.on(signal, handler)
    },
    unregister: (signal, handler) => {
      process.off(signal, handler)
    },
    exit: (code) => {
      process.exit(code)
    },
    raise: (signal) => {
      process.kill(process.pid, signal)
    },
    // Routed through `resolved` rather than the bare import so a test injecting
    // `deps.resetTerminal` still sees the signal path's resets.
    resetTerminal: () => {
      // Never the alternate screen: this fires while the PALETTE holds the terminal, and the palette
      // does not enter it. `?1049l` here would leave a buffer the session never entered.
      resolved.resetTerminal({ entersAltScreen: false })
    },
  }

  /**
   * Does the CHILD own Ctrl-C right now?
   *
   * Deliberately WIDER than "a child process is alive". It stays true from the spawn until the palette is
   * about to be drawn again — covering the terminal reset, the report read and the footer — because a user
   * force-quitting a child MASHES Ctrl-C, and the trailing SIGINTs land in exactly that gap. Letting one of
   * them reach the "no child running" branch is what used to `exit(0)` the entire session shell instead of
   * returning to the palette.
   */
  let childOwnsSigint = false
  const noopSignals: SessionSignals = {
    dispose: () => {
      return undefined
    },
    childStarted: () => {
      return undefined
    },
    quitRequested: () => {
      return false
    },
  }
  const sessionSignals =
    deps.installSignals === false
      ? noopSignals
      : installSessionSignals(() => {
          return childOwnsSigint
        }, signals)

  try {
    for (;;) {
      // An external SIGTERM arrived mid-child. We deferred it so the child could finish and its entry
      // could be committed; honour it now rather than re-rendering the palette over a `kill`.
      if (sessionSignals.quitRequested()) {
        return
      }

      // Hand Ctrl-C back to the palette HERE, and nowhere earlier. Everything between the child's exit
      // and this line — the terminal reset, the report read, the footer — is still fair game for the
      // trailing SIGINTs of a user mashing Ctrl-C at the child, and one of those reaching the
      // "no child running" branch would `exit(0)` the entire session. From this line on, the palette's
      // Ink holds stdin in raw mode (which disables ISIG), so a Ctrl-C there arrives as a `0x03` byte it
      // handles itself — not as a SIGINT at all.
      childOwnsSigint = false

      const selected = await deps.renderPalette(items)

      if (selected == null) {
        return
      }

      const command = deps.resolveCommand(selected)

      if (!command) {
        continue
      }

      // Echo first, exactly like a shell: the header must be on screen BEFORE the child starts
      // drawing, or a slow command (a 30s `audit --all`) prints its output under no heading at all.
      const header = formatRunHeader(commandLine(command), { color: resolved.color })

      write(`\n${header}\n`)
      sessionSignals.childStarted()

      const entry = await runOne(command, resolved, () => {
        childOwnsSigint = true
      })

      // Leading newline: the child may have exited mid-line, and the footer must not be welded to it.
      // Still inside the child's SIGINT window — see the top of the loop.
      write(`\n${entry}\n`)
    }
  } finally {
    sessionSignals.dispose()
  }
}
