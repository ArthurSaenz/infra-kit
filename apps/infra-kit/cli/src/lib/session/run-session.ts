import { chalkStderr } from 'chalk'
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import process from 'node:process'

import { equivalentLine } from './equivalent'
import { formatRunHeader, formatTranscriptEntry } from './format-entry'
import { classifyOutcome } from './outcome'
import { awaitPostRunKey } from './post-run-pause'
import type { PauseContext } from './post-run-pause'
import { SESSION_REPORT_ENV, newReportPath, readAndUnlinkReport } from './report'
import { resetTerminal } from './reset-terminal'
import { suspendForeground } from './suspend-foreground'

/**
 * @fileoverview
 * The persistent `infra-kit` session shell (React-free so it stays out of the eager Ink chunk and is
 * unit-testable with plain vitest). Each iteration: render the palette → echo the command → spawn it
 * as a fresh child that inherits this terminal → reap → read the child's report file → commit one
 * status footer → pause until the user presses a key → repeat, until the palette returns `null` (quit).
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
  /**
   * What happens between a finished command and the next palette draw. Resolves `'palette'` to
   * loop, or `'quit'` to end the session. Default: a raw single-keypress pause (see
   * `awaitPostRunKey`) on a TTY, and a no-op that resolves `'palette'` immediately anywhere else —
   * a non-TTY stdin arms nothing and writes nothing.
   *
   * OBLIGATION — an implementation that BLOCKS on input MUST call `ctx.armed()`, which flips the
   * signal phase to `'pause'`. One that returns synchronously must not.
   */
  // WHY A PAUSE AT ALL — scrollback. The palette frame is nearly viewport-tall, so redrawing it the
  // instant a command finishes scrolls that command's own output off the screen before the user has
  // read a line of it. The framing this shell exists to provide (header above, footer below, the
  // child's output between) is only worth having if it stays legible, so the loop stops here and
  // waits.
  //
  // Blocking with the phase still `'child'` runs the whole wait under the child's signal policy:
  // every SIGINT swallowed, and every SIGTERM deferred into a `quitRequested` flag nobody reads
  // until after a keypress that a `kill` cannot supply — an unkillable shell. `armed()` is an
  // assignment, so it is idempotent and a defensive second call is free.
  afterRun?: (ctx: PauseContext) => Promise<'palette' | 'quit'>
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
  refreshStderrSize()

  const columns: number | undefined = process.stderr.columns

  return columns != null && columns > 0 ? columns : undefined
}

/**
 * Re-read the terminal size from the kernel before every width read, via `_refreshSize()`.
 *
 * That method is underscore-prefixed and therefore not covered by node's semver contract, so it is
 * called through a `typeof` guard: on a non-tty stderr, or a node that renames it, the width simply
 * falls back to the cached value and the hint reverts to being stale rather than throwing.
 */
// `process.stderr.columns` is a CACHED field. Node fills it once at startup and refreshes it from
// SIGWINCH — and a stopped job is not in the foreground process group, so the resize that happens
// between a Ctrl-Z and an `fg` is delivered to the user's SHELL and never to us. The cached value
// then stays stale for the rest of the session. Measured on a pty: window 60 -> Ctrl-Z -> resize to
// 33 -> `fg`, and both `columns` and `getWindowSize()` still report 60 (`getWindowSize` returns the
// same cached pair, it is not an ioctl). The post-`fg` hint was therefore truncated to the OLD
// width, wrapped across two rows at the new one, and the single-row erase left the first row behind
// as a corpse — the exact failure the pause's fresh-read rule exists to prevent.
//
// `_refreshSize()` is the ioctl, and it is the only public-enough way to get one: it updates
// `columns`/`rows` in place and emits `'resize'` on change. Measured, it reports 33 in the case
// above.
const refreshStderrSize = (): void => {
  const stream = process.stderr as unknown as { _refreshSize?: () => void }

  if (typeof stream._refreshSize === 'function') stream._refreshSize()
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
const runOne = async (command: SessionCommand, deps: ResolvedDeps, enterChildPhase: () => void): Promise<string> => {
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

  enterChildPhase()
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
    // NOT the place to leave the `'child'` phase. The child's `exit` has fired, but the terminal reset
    // below, the report read, and the footer + palette draw are all still ahead — and a user force-quitting
    // the child MASHES Ctrl-C, so more SIGINTs are still landing. Moving the phase on here made every one of
    // them take the `'palette'` branch and `exit(0)` the WHOLE SESSION SHELL instead of returning to the
    // palette. The loop moves it back immediately before `renderPalette`, once the palette can own Ctrl-C.
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
   * Clock for the pnpm-relay window. A seam, not a convenience: the window is defined by elapsed time,
   * so a test that cannot move the clock could only assert it by sleeping.
   *
   * DELIBERATELY SEPARATE from the loop's `now` (which stamps transcript durations), even though both
   * default to `Date.now`. They want opposite things: a duration fake wants a FROZEN clock for a
   * deterministic footer, while this one reads a frozen clock as "no time has passed", which holds the
   * relay window permanently open and swallows every SIGTERM — the exact bug the window exists to fix.
   * Aliasing them made the seam fail OPEN. Keep them apart.
   */
  now: () => number
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
 * Which part of the session owns the terminal right now. The signal owner's whole policy is keyed on it.
 *
 * - `'palette'` — Ink owns stdin and the screen; the session sits between commands.
 * - `'child'` — a spawned command owns the tty. DELIBERATELY WIDER than "the child process is alive": it
 *   stays set through the terminal reset, the report read and the footer, and is only handed back at the
 *   top of the next iteration (see the assignment there for the Ctrl-C-mash reasoning).
 * - `'pause'` — the post-run keypress pause: raw stdin, a single hint row, no Ink frame on screen.
 *
 * This replaced a `childOwnsSigint` boolean, which carried TWO meanings at once — "swallow a stray SIGINT"
 * and "the tty has already stopped the foreground group, so follow it down". Those two agree as long as
 * only a child and a palette exist, and they come apart for the first time inside the pause, which
 * swallows SIGINT but must NOT stop itself. `command-palette.tsx` ends its account of the same
 * distinction with "DO NOT UNIFY THE TWO"; a phase is how that stays un-unified here.
 */
export type SessionPhase = 'palette' | 'child' | 'pause'

/**
 * How long after a Ctrl-C a SIGTERM may still be pnpm's relay of it. Beyond the window a SIGTERM
 * has no keypress to belong to and is treated as the external `kill` it is.
 */
// MEASURED, so the number is not a guess: driving a real `pnpm exec node` on a pty and pressing
// Ctrl-C, the relayed SIGTERM landed 6ms and 16ms after the SIGINT. A second is ~60x that — wide
// enough that load will not push a relay outside it, narrow enough that a human's deliberate `kill`
// never lands inside it.
//
// That same measurement also showed the relay is NOT guaranteed: 2 of 4 runs produced no SIGTERM at
// all. Which is exactly why this is a WINDOW and not a counter. The first cut licensed one swallow
// per Ctrl-C, but only a relay ever spends a licence — so on every run without one (and on the
// direct bin, which never relays) the licence was left unspent and a genuine `kill` seconds later
// was still swallowed. That narrowed the original bug from unbounded to N rather than fixing it.
//
// If the window is ever wrong, the failure is a session that quits after the current child instead
// of redrawing the palette — recoverable by rerunning `infra-kit`. It is deliberately the mild
// direction: the opposite error is a shell that cannot be killed.
const PNPM_RELAY_WINDOW_MS = 1_000

/**
 * Is this SIGTERM close enough behind a Ctrl-C to be pnpm's relay of it, rather than an external `kill`?
 *
 * Hoisted to module scope so each handler stays one flat run of guards — the technique `CommandPalette`
 * uses for the same reason.
 */
const isPnpmRelay = (lastSigintAt: number | null, now: number): boolean => {
  return lastSigintAt != null && now - lastSigintAt <= PNPM_RELAY_WINDOW_MS
}

/**
 * End the session from inside a signal handler. The reset comes FIRST and is not optional: `exit` runs
 * none of Ink's teardown, so without it the user's shell comes back to a hidden cursor, a stranded frame
 * and a tty that eats their keystrokes. See `resetTerminal` on `SessionSignalDeps`.
 */
const exitSession = (deps: SessionSignalDeps): void => {
  deps.resetTerminal()
  deps.exit(0)
}

/**
 * Install the session's phase-aware signal owners. The child is spawned WITHOUT `detached`, so it
 * shares this process's group — every tty-delivered signal reaches the child directly, and the
 * parent's job is only to decide what IT does. That depends entirely on which phase owns the
 * terminal (`SessionPhase`): a child on a cooked tty, the palette's Ink frame, or the post-run
 * pause's raw hint row.
 *
 * - SIGINT — swallowed in BOTH `'child'` and `'pause'`, so the tty's Ctrl-C stops only the child
 *   and the parent survives to render `⊘ cancelled` and loop. In `'palette'` it ends the session.
 * - SIGTERM — DEFERRED while a child runs (finish it, commit its transcript, then end the session),
 *   swallowed when it is pnpm's relay of a Ctrl-C, and an immediate exit in `'pause'` when it is not.
 * - SIGHUP — NEVER swallowed, in any phase: exit 129 with no reset.
 * - SIGTSTP — while a child runs we stop OURSELVES, so the whole foreground group suspends as a
 *   unit; in `'palette'` and `'pause'` it is delivered and IGNORED.
 */
// SIGINT. The two swallows differ in one respect. `'child'` RECORDS the moment (`lastSigintAt`) so
// a SIGTERM arriving right behind it can be recognised as pnpm's relay. `'pause'` records NOTHING,
// and that is the bound on the whole relay exemption: the pause blocks indefinitely by design, so a
// recorded SIGINT there would let a repeated `kill -INT` extend the swallow window without limit
// and hold the session immune to SIGTERM for as long as someone kept sending them. Not recording
// pins the window to the last Ctrl-C delivered while a CHILD ran (`lastSigintAt` is otherwise
// cleared only by `childStarted`), which bounds the exposure at one `PNPM_RELAY_WINDOW_MS` — after
// which the very next SIGTERM is honoured.
//
// The tty cannot generate a SIGINT during `'pause'` at all (raw mode clears ISIG), so the sources
// are an external `kill -INT` and — the case that matters — a tty SIGINT generated microseconds
// earlier while the child still held a cooked terminal, whose handler runs at the next event-loop
// boundary and so lands after the phase has flipped. That is the mashed-Ctrl-C case in signals
// rather than bytes.
//
// SIGTERM is DEFERRED, not dropped, while a child runs: dropping it outright would make the session
// unkillable by anything short of SIGKILL for as long as a child ran — and `dev` runs for hours.
// The exception is pnpm's RELAY. Under `pnpm exec infra-kit`, pnpm forwards a SIGTERM to us moments
// after the tty's Ctrl-C — that SIGTERM is an artifact of the SIGINT the user already aimed at the
// child, not a request to kill the session. (Causality, not a timing heuristic: the relay only
// exists because of the Ctrl-C.) Without a handler at all, that relay was an instant unhandled
// parent death — the shell prompt returned while the child still owned the tty and wrote teardown
// output over it.
//
// `'pause'` KEEPS that relay test, because the relay lands there: it was measured at 6ms and 16ms
// behind the SIGINT, and nothing suspends between the child's `exit` and the pause arming — the
// reset, the report read, the formatter and the footer are all synchronous, and the one `await` in
// the chain resolves as a microtask, which cannot interleave with a signal dispatched from libuv's
// poll phase. So a fast child stopped with Ctrl-C has its relay arrive in `'pause'`, and routing
// SIGTERM there straight to exit would kill the session on an ordinary Ctrl-C. What `'pause'`
// changes is the OTHER half: a SIGTERM that FAILS the relay test exits IMMEDIATELY instead of
// setting `quitRequested`, because there is no child left whose transcript needs committing and
// nothing would read the flag until a keypress that a `kill` cannot supply.
//
// SIGHUP means the terminal is gone, so staying alive would leave the session looping on a dead
// tty, drawing frames into a closed fd. There is nothing left to clean. The child gets its own
// SIGHUP and is responsible for its own reap (see `dev/signal-shutdown.ts`).
//
// SIGTSTP. While a CHILD runs we STOP OURSELVES, because the tty already delivered SIGTSTP to the
// whole foreground group: the child has stopped, and if the parent merely ignored the signal (as it
// used to) it would sit in `waitForExit` awaiting an exit that can never come, wedging the terminal
// with no prompt and no way back. Stopping too suspends the FOREGROUND GROUP as a unit, so the
// user's shell reclaims the tty and prints a prompt; `fg` sends SIGCONT to the group and both
// resume. Handlers survive stop/continue, so there is nothing to re-arm.
//
// CAVEAT — a child's own DETACHED descendants keep running: `dev`'s turbo/vite children sit in
// their own process groups, so a Ctrl-Z out of `dev` suspends `dev` itself while its servers stay
// up and bound to their ports. Recoverable with `fg`, and strictly better than the wedge it
// replaced, but "suspended" is not the whole truth for `dev`.
//
// In `'palette'` AND `'pause'` SIGTSTP is ignored because raw mode stops the tty from generating
// one there, but an external `kill -TSTP` still arrives, and self-stopping would hand the user's
// shell a raw tty with a stranded row (the pause's hint) or a half-drawn Ink frame (the palette).
//
// DO NOT UNIFY THIS WITH THE SIGINT ROW. A tty SIGTSTP means the whole group has already stopped
// and we must follow it down; a keyboard Ctrl-Z at the pause is the raw byte `0x1a` read by the
// pause itself, which drops raw mode before suspending. They look alike and are not the same event.
export const installSessionSignals = (getPhase: () => SessionPhase, deps: SessionSignalDeps): SessionSignals => {
  // Per-child signal history: a SIGTERM is pnpm's relay only if a SIGINT preceded it RECENTLY, for THIS
  // child. Proximity is the whole rule — see PNPM_RELAY_WINDOW_MS for why it is a timestamp and not the
  // flag (or the counter) this started as.
  let lastSigintAt: number | null = null
  let quitRequested = false

  const onSigint = (): void => {
    const phase = getPhase()

    if (phase === 'child') {
      // The child got its own copy from the tty; ours only records WHEN the Ctrl-C happened, so a
      // SIGTERM arriving right behind it can be recognised as pnpm's relay rather than an external kill.
      lastSigintAt = deps.now()

      return
    }

    if (phase === 'pause') {
      // Swallowed, and deliberately NOT recorded — recording here would let a repeated `kill -INT` extend
      // the relay-swallow window without bound. See the handler doc above.
      return
    }

    exitSession(deps)
  }
  const onSigterm = (): void => {
    const phase = getPhase()

    if (phase === 'palette') {
      // Same reason as SIGINT above: an external `kill` can land mid-palette, and Ink's teardown is skipped.
      exitSession(deps)

      return
    }

    if (isPnpmRelay(lastSigintAt, deps.now())) {
      // pnpm's relay of the Ctrl-C the user aimed at the child. Not a request to end the session — and it
      // frequently arrives after the child is already gone and the pause is armed.
      return
    }

    if (phase === 'pause') {
      // A genuine external `kill` with no child left to finish. Deferring it would wait for a keypress the
      // `kill` cannot supply, so end the session here.
      exitSession(deps)

      return
    }

    // A genuine external `kill` during a child. Let the child finish and its entry commit, then stop.
    quitRequested = true
  }
  const onSighup = (): void => {
    // The tty is gone. There is nothing left to render into and no user to render for.
    deps.exit(129)
  }
  const onSigtstp = (): void => {
    if (getPhase() !== 'child') {
      // Palette or pause: ignore, or we would suspend leaving a partial Ink frame — or a raw tty and a
      // stranded hint row — committed to the user's screen.
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
      lastSigintAt = null
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
 * The platform authority on Ctrl-Z, decided ONCE at module scope rather than per pause.
 *
 * `undefined` means suspending is impossible: win32 has no SIGSTOP, so the pause drops the suspend
 * clause from its hint and reads `0x1a` as an ordinary key. See `suspendForeground` for the caller
 * preconditions the pause satisfies before it calls this.
 */
const SUSPEND_SEAM: (() => void) | undefined =
  process.platform === 'win32'
    ? undefined
    : () => {
        suspendForeground()
      }

/**
 * The default `afterRun`: the raw single-keypress pause, wired to the same stderr seam, width function
 * and glyph/colour verdicts the transcript is framed with — so a resize between two commands changes the
 * hint exactly as it changes the footer's rule.
 *
 * Hoisted to module scope so `runSession` stays one flat run of dep resolution; `stdin` is deliberately
 * omitted, because the pause defaults it to `process.stdin` itself and that is the only place the real
 * stream should be named.
 */
const defaultAfterRun = (write: (text: string) => void, resolved: ResolvedDeps) => {
  return (ctx: PauseContext): Promise<'palette' | 'quit'> => {
    return awaitPostRunKey(ctx, {
      write,
      columns: resolved.columns,
      ascii: resolved.ascii,
      color: resolved.color,
      suspend: SUSPEND_SEAM,
    })
  }
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

  /**
   * Which phase owns the terminal right now — read by the signal handlers below on every delivery, and by
   * the seam's own reset. Declared BEFORE `signals` because that object's `resetTerminal` closure reads it.
   *
   * See `SessionPhase` for what each value covers and why this is a phase rather than the boolean it
   * replaced. `'child'` is set around the spawn; `'pause'` is set by the `afterRun` context below, on
   * behalf of whichever implementation of that seam is blocking on input.
   */
  let phase: SessionPhase = 'palette'

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
    // Its OWN clock, NOT `resolved.now` — see the field's doc on SessionSignalDeps. Sharing the loop's
    // seam meant a test freezing `now` for deterministic transcript durations silently pinned the relay
    // window open, so the seam failed open instead of closed.
    now: () => {
      return Date.now()
    },
    // Routed through `resolved` rather than the bare import so a test injecting
    // `deps.resetTerminal` still sees the signal path's resets.
    resetTerminal: () => {
      if (phase === 'pause') {
        // Erase the pause's hint row before the reset, or the shell prompt draws at column 0 with the
        // hint's tail still to its right. PHASE-SCOPED on purpose: `\u001B[2K` (EL) is erase-in-LINE, and a
        // stranded palette frame is multi-row by construction — blanking one row of six would make that
        // corpse worse, not better. It is also never on the post-child reset above, which must not wipe
        // the child's last output line.
        write('\r\u001B[2K')
      }

      // Never the alternate screen: this fires while the PALETTE (or the pause) holds the terminal, and
      // neither enters it. `?1049l` here would leave a buffer the session never entered.
      resolved.resetTerminal({ entersAltScreen: false })
    },
  }

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
          return phase
        }, signals)

  /**
   * Built HERE and passed on EVERY call — to the default implementation and to any injected one alike.
   * Closing the signal window is a loop invariant, not a property of one implementation: baking these
   * two callbacks privately into the default factory would make an injected `afterRun` silently wrong,
   * and would divorce every unit test from the behaviour it is meant to pin.
   */
  const pauseContext: PauseContext = {
    armed: () => {
      phase = 'pause'
    },
    quitRequested: () => {
      return sessionSignals.quitRequested()
    },
  }
  const afterRun = deps.afterRun ?? defaultAfterRun(write, resolved)

  try {
    for (;;) {
      // An external SIGTERM arrived mid-child. We deferred it so the child could finish and its entry
      // could be committed; honour it now rather than re-rendering the palette over a `kill`.
      if (sessionSignals.quitRequested()) {
        return
      }

      // Hand Ctrl-C back to the palette HERE, and nowhere earlier. Everything between the child's exit
      // and this line — the terminal reset, the report read, the footer — is still fair game for the
      // trailing SIGINTs of a user mashing Ctrl-C at the child, and one of those reaching the `'palette'`
      // branch would `exit(0)` the entire session. From this line on, the palette's Ink holds stdin in raw
      // mode (which disables ISIG), so a Ctrl-C there arrives as a `0x03` byte it handles itself — not as a
      // SIGINT at all.
      //
      // This is also where the loop comes back from `'pause'`: that phase drops raw mode before it
      // resolves, so the sequence into the palette is exactly the one below.
      phase = 'palette'

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
        phase = 'child'
      })

      // Leading newline: the child may have exited mid-line, and the footer must not be welded to it.
      // Still inside the child's SIGINT window — see the top of the loop.
      write(`\n${entry}\n`)

      // AFTER the footer, and on every iteration that actually ran a command: the transcript block must
      // be complete on screen before we ask the user to read it. (The `!command` path above `continue`s
      // past this — nothing ran, so there is nothing to hold the screen for.)
      if ((await afterRun(pauseContext)) === 'quit') {
        return
      }
    }
  } finally {
    sessionSignals.dispose()
  }
}
