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
export const formatFault = (event: FaultEvent, error: unknown): string => {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? '(no stack)'}` : String(error)

  return (
    `\n⚠️  ${event}: ${detail}\n` +
    `   dev-server kept alive (likely a bug in a handler's async path); restart if it misbehaves.\n`
  )
}

/** Default fault reporter: straight to stderr. Replaced by the dev entry, which also files + counts it. */
const defaultOnFault = (event: FaultEvent, error: unknown): void => {
  writeStderr(formatFault(event, error))
}

const defaultRegister = (event: FaultEvent, handler: (error: unknown) => void): void => {
  process.on(event, handler)
}

/**
 * Install the crash barrier: wire `uncaughtException` and `unhandledRejection` to `onFault` and DO NOT
 * exit, so a single escaped async path in an in-process backend handler no longer tears the whole dev
 * session down. The handler never rethrows — rethrowing would re-arm the very termination this prevents.
 *
 * @example
 * registerCrashBarrier() // resident dev process survives a handler's stray rejection, logs it loudly
 */
export const registerCrashBarrier = ({
  onFault = defaultOnFault,
  register = defaultRegister,
}: CrashBarrierDeps = {}): void => {
  const handle = (event: FaultEvent) => {
    return (error: unknown): void => {
      onFault(event, error)
    }
  }

  register('uncaughtException', handle('uncaughtException'))
  register('unhandledRejection', handle('unhandledRejection'))
}
