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
  /** Terminal hygiene after each child (default: the real escapes; tests inject a spy). */
  resetTerminal?: (opts: { entersAltScreen?: boolean }) => void
  /** Install real SIGINT/SIGTSTP handlers (default true; tests pass false to stay signal-free). */
  installSignals?: boolean
}

/** The replayable command line for a pick — echoed as the header, and the default equivalent line. */
const commandLine = (command: SessionCommand): string => {
  return `infra-kit ${command.groupPath.join(' ')}`
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

/**
 * Run one picked command as a child on THIS terminal and format the footer that closes it out. The
 * header is echoed by the caller before we spawn, so the child's output arrives under a heading.
 */
const runOne = async (
  command: SessionCommand,
  deps: Required<Pick<RunSessionDeps, 'spawn' | 'now' | 'env' | 'cliPath' | 'ascii' | 'resetTerminal'>>,
  setChildRunning: (running: boolean) => void,
): Promise<string> => {
  const reportPath = newReportPath()
  const childEnv: NodeJS.ProcessEnv = {
    ...deps.env,
    [SESSION_REPORT_ENV]: reportPath,
    // Every child would otherwise re-run the daily auto-update check and spawn its own detached
    // worker; opt them all out. The parent's own startup check (before the palette) still runs.
    INFRA_KIT_NO_AUTO_UPDATE: '1',
  }
  const start = deps.now()

  let result: { code: number | null; signal: NodeJS.Signals | null } = { code: 1, signal: null }

  setChildRunning(true)
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
    setChildRunning(false)
    // After EVERY child, not just cancelled ones: a child killed mid-draw leaves the cursor hidden,
    // the colour set, or the cursor parked mid-line, and the footer would be welded onto it.
    deps.resetTerminal({ entersAltScreen: command.entersAltScreen })
  }

  const record = readAndUnlinkReport(reportPath)
  const outcome = classifyOutcome(result.code, result.signal, record != null)
  const headerLine = commandLine(command)
  const equivalent = record?.equivalent ?? equivalentLine(headerLine, true)

  return formatTranscriptEntry({
    equivalent,
    outcome,
    durationMs: deps.now() - start,
    summary: record?.summary,
    envNotice: command.sessionEnvNotice,
    ascii: deps.ascii,
    // We already echoed this line before the spawn. Repeat it only when the child reported back a
    // DIFFERENT one — an interactive command folding its resolved flags into a replayable `≈` line.
    showEquivalent: !(equivalent.reproducible && equivalent.line === headerLine),
  })
}

/**
 * Install the session's state-aware signal owners. While a child runs, SIGINT is swallowed so the
 * tty-delivered signal kills only the child (which installs no SIGINT handler) and the parent
 * survives to render `⊘ cancelled` and loop; between iterations (cooked mode) SIGINT quits cleanly.
 * Returns a cleanup that removes both handlers.
 *
 * SIGTSTP is ignored for the session's lifetime: a suspended session would leave a half-drawn palette
 * frame and a child holding the tty. KNOWN LIMITATION — Ctrl-Z during a child hangs the terminal:
 * SIGTSTP goes to the whole foreground process group, so the child stops while the parent ignores the
 * signal and keeps awaiting an exit that never comes. Pre-existing; fixing it means forwarding the
 * stop to the child's pgid and re-arming on SIGCONT.
 */
const installSessionSignals = (isChildRunning: () => boolean): (() => void) => {
  const onSigint = (): void => {
    if (isChildRunning()) {
      return
    }
    // Cooked between-iterations window: a real Ctrl-C here should end the session (exit 0).
    process.exit(0)
  }
  const onSigtstp = (): void => {
    // Ignore unconditionally: suspending mid-child or mid-palette would strand a partial frame.
  }

  process.on('SIGINT', onSigint)
  process.on('SIGTSTP', onSigtstp)

  return () => {
    process.off('SIGINT', onSigint)
    process.off('SIGTSTP', onSigtstp)
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

  let childRunning = false
  const cleanupSignals =
    deps.installSignals === false
      ? () => {
          return undefined
        }
      : installSessionSignals(() => {
          return childRunning
        })

  try {
    for (;;) {
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
      const header = formatRunHeader(commandLine(command))

      write(`\n${header}\n`)

      const entry = await runOne(command, resolved, (running) => {
        childRunning = running
      })

      // Leading newline: the child may have exited mid-line, and the footer must not be welded to it.
      write(`\n${entry}\n`)
    }
  } finally {
    cleanupSignals()
  }
}
