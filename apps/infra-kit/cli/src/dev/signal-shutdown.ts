/**
 * Signal-driven graceful shutdown, shared by every long-lived dev entry point.
 *
 * Three invariants:
 *
 * 1. Only a REPEAT OF THE SAME SIGNAL is an escape hatch. It is tempting to treat any second
 *    signal as "the user pressed Ctrl-C again, get out now" — that was the old rule, and it
 *    silently orphaned every child. A process manager in front of us relays its own signal after
 *    the TTY's, so ONE Ctrl-C under `pnpm exec` arrives as SIGINT *then* SIGTERM:
 *
 *      $ pnpm exec node -e "process.on('SIGINT',…); process.on('SIGTERM',…)"
 *      ^C  GOT SIGINT
 *          GOT SIGTERM      <- pnpm relaying, NOT a second keypress
 *
 *    Under the old rule that relay force-quit the teardown a few hundred ms in and abandoned the
 *    turbo/vite children (which sit in their own process groups). Keying the escape on the FIRST
 *    signal's type fixes it without losing the hatch: a real second Ctrl-C re-sends SIGINT, and a
 *    supervisor escalating SIGTERM -> SIGTERM still force-quits. `npm`/`yarn` relay the same way,
 *    so this must live here, in the library, not in one consumer's `dev` script.
 * 2. Force-quitting must still not orphan. Even a genuine double Ctrl-C leaves children holding
 *    ports (the next start then 502s), so the force path SIGKILLs the descendant process groups
 *    before exiting. Bounded and synchronous — no grace, no escalation, no waiting for reaping.
 * 3. A signal-terminated process must not report exit code 0. The old handlers ran
 *    `finally { process.exit(0) }`, which also swallowed a rejecting teardown without a word.
 *    Here the rejection goes to stderr and the code stays `128 + signo` — even on a failed
 *    teardown, because the process genuinely WAS signal-terminated, no conventional code means
 *    "signal-terminated but cleanup failed", and inventing one would break the SIGTERM -> 143
 *    contract supervisors rely on. The failure is surfaced by logging, not by the code.
 */
import { constants } from 'node:os'
import process from 'node:process'

import { killDescendantGroupsNow } from 'src/dev/managed-child'

/**
 * The signals a resident dev process tears down on.
 *
 * SIGHUP is here for invariant 2: the terminal going away (window closed, ssh dropped) is delivered to
 * the foreground process group, so `dev` gets it — but its turbo/vite children DON'T, because they sit
 * in their own detached process groups. Without a handler, `dev` takes SIGHUP's default kill, never runs
 * `killDescendantGroupsNow`, and leaves the whole tree alive holding the dev ports; the next start then
 * 502s. Closing a terminal is the single most common way to walk away from a dev server, so this is the
 * likeliest orphan path, not an exotic one.
 */
const HANDLED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * `os.constants.signals` typed for lookup by an arbitrary {@link NodeJS.Signals}. The platform
 * table omits signals that do not exist on the host, so the index is genuinely partial.
 */
const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = constants.signals

/** Fallback signal number when the host table lacks the signal: SIGINT, yielding the usual 130. */
const FALLBACK_SIGNO = 2

/**
 * The POSIX exit code for a process terminated by `signal`: `128 + signo`.
 *
 * A shell reports SIGINT as 130 and SIGTERM as 143. Exiting 0 after a signal tells a supervisor
 * the process stopped voluntarily, which is a lie.
 *
 * @example
 * exitCodeForSignal('SIGINT') // 130
 * exitCodeForSignal('SIGTERM') // 143
 */
export const exitCodeForSignal = (signal: NodeJS.Signals): number => {
  return 128 + (SIGNAL_NUMBERS[signal] ?? FALLBACK_SIGNO)
}

/**
 * Seams for {@link registerSignalShutdown}. Each exists because the real implementation is
 * untestable in-process: `process.exit` kills the test runner, and delivering a real POSIX
 * signal to the runner is unsafe and flaky.
 */
export interface SignalShutdownDeps {
  /** The context-specific teardown. May reject; the rejection is logged, never swallowed. */
  onSignal: (signal: NodeJS.Signals) => Promise<void>
  /**
   * Terminate the process. Typed as returning `void`, not `never`, so a test can pass a plain
   * recording fake: a `never` fake would have to throw a sentinel, and that throw would reject the
   * in-flight teardown promise. Nothing meaningful runs after a call, so a returning fake is safe.
   */
  exit?: (code: number) => void
  /** Subscribe `handler` to `signal`. Defaults to `process.on`. */
  register?: (signal: NodeJS.Signals, handler: () => void) => void
  /**
   * Reap surviving descendant process groups on the force-quit path, where the normal teardown is
   * abandoned mid-flight. Synchronous by contract: the process exits on the next line, so anything
   * deferred to a later tick would never run. Defaults to {@link killDescendantGroupsNow}.
   */
  forceReap?: () => void
}

const defaultExit = (code: number): void => {
  process.exit(code)
}

const defaultRegister = (signal: NodeJS.Signals, handler: () => void): void => {
  process.on(signal, handler)
}

/**
 * Write to stderr, swallowing a failed write.
 *
 * `stderr.write` can throw (EPIPE, when the parent closed the pipe). Every caller here is on the
 * exit path, and failing to REPORT something must never break that path — the process still has to
 * die with the right code. A lost message is recoverable; a process that survives its own SIGINT
 * is not.
 */
const writeStderr = (message: string): void => {
  try {
    process.stderr.write(message)
  } catch {
    // stderr is gone; there is nowhere left to report to.
  }
}

/** Report a rejected teardown — message AND stack, so a wedge is never silent. */
const writeTeardownFailure = (signal: NodeJS.Signals, error: unknown): void => {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? '(no stack)'}` : String(error)

  writeStderr(`\n✗ Teardown failed while handling ${signal}: ${detail}\n`)
}

/**
 * Wire SIGINT/SIGTERM to `onSignal`, then exit `128 + signo`.
 *
 * The first signal runs the teardown. While it is in flight, a signal of a DIFFERENT type is a
 * relay from the process manager above us (`pnpm exec` turns one Ctrl-C into SIGINT + SIGTERM) and
 * is ignored, so the teardown survives to reap its children. A repeat of the FIRST signal is the
 * real escape hatch: it force-quits without touching `onSignal` again, SIGKILLing the descendant
 * groups on the way out so nothing is left holding a port.
 *
 * No force-deadline is armed. Any value safe enough not to preempt a legitimate teardown would
 * fire later than a user's second Ctrl-C, and a supervisor sends its own SIGKILL on its own grace.
 *
 * @example
 * registerSignalShutdown({
 *   onSignal: async (signal) => {
 *     process.stdout.write(`Received ${signal}, shutting down...`)
 *     await runner.shutdown()
 *   },
 * })
 */
export const registerSignalShutdown = ({
  onSignal,
  exit = defaultExit,
  register = defaultRegister,
  forceReap = killDescendantGroupsNow,
}: SignalShutdownDeps): void => {
  /** The signal that opened the teardown — `null` until the first one lands. */
  let firstSignal: NodeJS.Signals | null = null

  const handle = (signal: NodeJS.Signals): void => {
    if (firstSignal !== null) {
      // A DIFFERENT signal while tearing down is the process manager in front of us relaying its
      // own (pnpm/npm turn one Ctrl-C into SIGINT + SIGTERM), never a second keypress. Ignoring it
      // is what lets the teardown finish and reap the children. Only a repeat of the signal that
      // STARTED the teardown is the user (or a supervisor) genuinely asking again.
      if (signal !== firstSignal) return

      writeStderr(`\n⚠  Received ${signal} again — force-quitting.\n`)
      // Abandoning the teardown must still not abandon the children: they hold the dev ports, and
      // the next start would 502 against their stale portless aliases.
      forceReap()
      exit(exitCodeForSignal(signal))

      return
    }

    firstSignal = signal

    void (async (): Promise<void> => {
      try {
        await onSignal(signal)
      } catch (error) {
        writeTeardownFailure(signal, error)
      } finally {
        // `finally`, so the exit survives anything the catch body might later throw: a process must
        // never outlive its own signal. Not the old `finally { process.exit(0) }` bug — that one
        // exited zero without logging; this logs first, then exits the honest code.
        exit(exitCodeForSignal(signal))
      }
    })()
  }

  for (const signal of HANDLED_SIGNALS) {
    register(signal, () => {
      return handle(signal)
    })
  }
}
