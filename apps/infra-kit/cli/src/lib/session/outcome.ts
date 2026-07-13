/**
 * Pure classifier that turns a finished session's exit signals into a single
 * {@link SessionOutcome}. Report-presence is decided FIRST: a written report means
 * the command produced a verdict, so a late teardown signal (e.g. SIGINT during
 * cleanup after the report was flushed) is still a success. Only when NO report
 * exists does the signal/exit code decide between a user cancellation and a
 * genuine failure. Side-effect-free so the mapping is fully unit-testable.
 */

/** The four terminal states a session can settle into. */
export type SessionOutcome = 'ok' | 'findings' | 'failed' | 'cancelled'

/**
 * The exit codes a command that handles its own termination signal reports on a clean stop: `128 + signo`
 * for SIGINT (130) and SIGTERM (143). Deliberately NOT a `> 128` range check — SIGKILL (137) means the
 * kernel or an OOM killer stepped in, and SIGSEGV (139) is a crash. Those must stay `failed`.
 *
 * SIGHUP (129) is absent for a reason that lives in ANOTHER file, so changing that file must bring you
 * back here: the session parent exits on SIGHUP the moment it arrives (`run-session.ts`, `onSighup`), so
 * no footer is ever classified for a hangup and 129 is unreachable. If SIGHUP is ever made to DEFER like
 * SIGTERM, add 129 to this set in the same commit — otherwise a hangup out of `dev` starts silently
 * reading as `✗ failed`.
 */
const SIGNAL_STOP_EXIT_CODES = new Set([130, 143])

/**
 * Classify a finished session. When a report was written, the run completed:
 * exit 0 (or any teardown signal) is `ok`, a non-zero exit is `findings`. When no
 * report was written, a `SIGINT` or clean exit is a user `cancelled`, anything
 * else is `failed`.
 *
 * `longRunning` marks a child that runs until the user stops it (`dev`). Such a child installs its own
 * SIGINT handler and exits `128 + signo` BY DESIGN — it is not killed BY the signal, so it reports exit
 * 130 with a null `signal`, which is indistinguishable from a crash on the default path. Without this
 * flag every normal Ctrl-C out of `dev` would be stamped `failed`.
 *
 * @example
 * classifyOutcome(0, null, true)          // => 'ok'
 * classifyOutcome(1, null, true)          // => 'findings'
 * classifyOutcome(null, 'SIGINT', true)   // => 'ok' (teardown after the report was written)
 * classifyOutcome(1, null, false)         // => 'failed'
 * classifyOutcome(0, null, false)         // => 'cancelled'
 * classifyOutcome(130, null, false, true) // => 'cancelled' (dev, stopped with Ctrl-C)
 * classifyOutcome(1, null, false, true)   // => 'failed'    (dev, crashed on boot)
 */
export const classifyOutcome = (
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  reportPresent: boolean,
  longRunning = false,
): SessionOutcome => {
  if (reportPresent) {
    return signal != null || exitCode === 0 ? 'ok' : 'findings'
  }

  if (longRunning && exitCode != null && SIGNAL_STOP_EXIT_CODES.has(exitCode)) {
    return 'cancelled'
  }

  return signal === 'SIGINT' || exitCode === 0 ? 'cancelled' : 'failed'
}
