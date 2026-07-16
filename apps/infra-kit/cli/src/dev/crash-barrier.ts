/**
 * Process-level crash barrier for the resident single-process dev-server.
 *
 * The backends run IN-PROCESS (`ServerlessLocalRun` is an in-process fastify that `import()`s the
 * compiled handler), so they share the runner's event loop. Fastify catches errors thrown INSIDE a
 * route handler and turns them into a 500 — but a stray async path a handler forgot to await
 * (`unhandledRejection`) or a throw from a timer/emitter (`uncaughtException`) escapes to the process
 * and, by Node's defaults, terminates it. That kills the WHOLE dev session — every backend, the watch
 * engine, the UI child — over one bad path in one handler.
 *
 * This barrier keeps the session alive and reports the fault loudly instead, the same resilience
 * `nodemon`/`vite dev`/`next dev` give. The tradeoff is deliberate and dev-only: it is installed by the
 * CLI entry point, never by library code, so it can never mask a fault in a production consumer.
 *
 * Node's caveat stands: after an `uncaughtException` the process may be in an undefined state. For a
 * local dev tool a possibly-degraded session the developer can see and restart beats a hard exit that
 * looks like the tool itself crashed. The fault is surfaced with a full stack so it is never silent.
 */
import process from 'node:process'

import { killDescendantGroupsNow } from 'src/dev/managed-child'

/** The two process-level fault channels that terminate Node by default. */
type FaultEvent = 'uncaughtException' | 'unhandledRejection'

/**
 * Seams for {@link registerCrashBarrier}. Each exists because the real implementation is untestable
 * in-process: attaching real `process.on('uncaughtException')` handlers in the test runner would swallow
 * the runner's own faults, and there is nothing to assert against a handler that only logs to stderr.
 */
export interface CrashBarrierDeps {
  /** Report the fault. Defaults to a guarded stderr write. Must not throw. */
  onFault?: (event: FaultEvent, error: unknown) => void
  /** Subscribe `handler` to `event`. Defaults to `process.on`. */
  register?: (event: FaultEvent, handler: (error: unknown) => void) => void
  /**
   * Is our own stdio unwritable? The ONE discriminator between "survive" and "die" — see
   * `terminal-liveness.ts`. Defaults to `() => false`, so the LIBRARY's behaviour is unchanged: the exit
   * path is opt-in and wired only by the CLI entry, exactly as this whole barrier is.
   *
   * It must never be re-implemented as an error-code sniff (`EIO`/`EPIPE`). A handler writing to a client
   * socket that hung up throws `EPIPE` too, so a code-sniff would let ONE user closing a browser tab
   * mid-request kill the entire dev session — the very fragility the barrier exists to remove, re-armed.
   */
  isTerminalDead?: () => boolean
  /**
   * File the fault where it can still be READ once the terminal cannot be written to. The dev entry routes
   * this into the log sink; the default falls back to the guarded stderr write, which may itself be lost —
   * a lost report is recoverable, an unbounded loop is not.
   */
  fileFault?: (event: FaultEvent, error: unknown) => void
  /**
   * Terminate the session because stdio is gone. Reached ONLY when {@link isTerminalDead} is true: a fault
   * reported onto a dead stream is what produced the fault, and surviving it means spinning forever.
   * Defaults to a force-reap of the descendant groups (they hold the dev ports) plus `process.exit`.
   */
  onFatal?: (reason: string) => void
}

/**
 * Write to stderr, swallowing a failed write. Mirrors `signal-shutdown`'s `writeStderr`: reporting must
 * never itself throw on the fault path (EPIPE when the parent closed the pipe), and a lost message is
 * recoverable where a barrier that throws is not.
 */
const writeStderr = (message: string): void => {
  try {
    process.stderr.write(message)
  } catch {
    // stderr is gone; there is nowhere left to report to.
  }
}

/**
 * The fault report, as one string: message AND stack, plus a note that the session was kept alive.
 *
 * Exported because the dev-server must route this into the panel's error counter and onto the terminal
 * through the interceptor's bypass. `infra-kit dev` no longer prints logs, and the interceptor owns
 * `process.stderr` — so the default stderr write below would file a crash into a log file and leave the
 * panel showing a healthy, silent session. A fault is the one thing that may never be quiet.
 */
export const formatFault = (event: FaultEvent, error: unknown, kept = true): string => {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? '(no stack)'}` : String(error)
  // `kept` is not cosmetic. On the fatal path the session is NOT kept alive, and a trailing "kept alive"
  // there is a lie filed into the one log a post-mortem will actually read. Defaulted to `true` so the
  // survive path — the barrier's entire reason for existing — is byte-identical to before.
  const outcome = kept
    ? `   dev-server kept alive (likely a bug in a handler's async path); restart if it misbehaves.\n`
    : `   dev-server is shutting down: its stdio is unwritable, so reporting this fault would loop forever.\n`

  return `\n⚠️  ${event}: ${detail}\n${outcome}`
}

/** Default fault reporter: straight to stderr. Replaced by the dev entry, which also files + counts it. */
const defaultOnFault = (event: FaultEvent, error: unknown): void => {
  writeStderr(formatFault(event, error))
}

/**
 * Default filer for the fatal path. Stderr is very likely the stream that just died — this write is
 * expected to be dropped, and that is acceptable: the CLI entry overrides it with the log sink, which is
 * the only channel left when stdio is gone.
 */
const defaultFileFault = (event: FaultEvent, error: unknown): void => {
  writeStderr(formatFault(event, error, false))
}

/**
 * Default fatal action: SIGKILL the descendant process GROUPS before exiting. Not `process.exit` alone —
 * turbo and vite sit in their own detached groups, so an exit that skips the reap leaves them holding the
 * dev ports and the next `infra-kit dev` 502s against their stale aliases. That is the orphan half of the
 * incident this exists for (five processes, alive for five hours).
 */
const defaultOnFatal = (reason: string): void => {
  writeStderr(`\n✗ dev-server exiting: ${reason}\n`)
  killDescendantGroupsNow()
  process.exit(1)
}

const defaultRegister = (event: FaultEvent, handler: (error: unknown) => void): void => {
  process.on(event, handler)
}

/**
 * Install the crash barrier: wire `uncaughtException` and `unhandledRejection` to `onFault` and DO NOT
 * exit, so a single escaped async path in an in-process backend handler no longer tears the whole dev
 * session down. The handler never rethrows — rethrowing would re-arm the very termination this prevents.
 *
 * The ONE exception is {@link CrashBarrierDeps.isTerminalDead}: when our own stdio can no longer be
 * written to, "report it loudly and survive" is not resilience, it is the loop — the report goes to the
 * dead stream, fails, and comes straight back here. So on that path the fault is FILED (never printed) and
 * the session exits. This is a backstop, not the fix: `terminal-liveness` already initiates the same
 * bounded teardown from the stream's own `'error'` event, and this covers a fault arriving from a stream
 * that listener does not own.
 *
 * @example
 * registerCrashBarrier() // resident dev process survives a handler's stray rejection, logs it loudly
 */
export const registerCrashBarrier = ({
  onFault = defaultOnFault,
  register = defaultRegister,
  isTerminalDead = () => {
    return false
  },
  fileFault = defaultFileFault,
  onFatal = defaultOnFatal,
}: CrashBarrierDeps = {}): void => {
  const handle = (event: FaultEvent) => {
    return (error: unknown): void => {
      if (isTerminalDead()) {
        fileFault(event, error)
        // The reason names the CHANNEL, not a story: the errno-bearing reason comes from the liveness
        // listener; here all we honestly know is that a fault arrived while stdio was already unwritable.
        onFatal(`${event} while stdio is unwritable`)

        return
      }

      onFault(event, error)
    }
  }

  register('uncaughtException', handle('uncaughtException'))
  register('unhandledRejection', handle('unhandledRejection'))
}
