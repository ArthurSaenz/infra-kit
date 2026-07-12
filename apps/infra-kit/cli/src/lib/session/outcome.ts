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
 * Classify a finished session. When a report was written, the run completed:
 * exit 0 (or any teardown signal) is `ok`, a non-zero exit is `findings`. When no
 * report was written, a `SIGINT` or clean exit is a user `cancelled`, anything
 * else is `failed`.
 *
 * @example
 * classifyOutcome(0, null, true)        // => 'ok'
 * classifyOutcome(1, null, true)        // => 'findings'
 * classifyOutcome(null, 'SIGINT', true) // => 'ok' (teardown after the report was written)
 * classifyOutcome(1, null, false)       // => 'failed'
 * classifyOutcome(0, null, false)       // => 'cancelled'
 */
export const classifyOutcome = (
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  reportPresent: boolean,
): SessionOutcome => {
  if (reportPresent) {
    return signal != null || exitCode === 0 ? 'ok' : 'findings'
  }

  return signal === 'SIGINT' || exitCode === 0 ? 'cancelled' : 'failed'
}
