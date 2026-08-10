/**
 * Owns the `'error'` channel of `process.stdout` / `process.stderr` — the ONLY point at which a failed
 * stdio write can be observed, and therefore the only place the fault loop can be cut.
 *
 * Why an `'error'` listener and nothing else (each alternative was probed, and each one silently fails):
 *
 * - A stdio write NEVER throws synchronously. Node builds the error in `afterWriteDispatched`, routes it
 *   through `destroy(err, cb)`, and `internal/streams/destroy.js` schedules `process.nextTick(emitErrorCloseNT)`.
 *   It surfaces a TICK LATER as an unhandled `'error'` event, which Node then turns into an
 *   `uncaughtException`. So a `try/catch` around the writer catches nothing, and a synchronous
 *   re-entrancy latch sees an empty stack.
 * - `stdout.destroyed` / `stdout.writable` are dead discriminators: Node's stdio streams carry a
 *   `dummyDestroy` that `_undestroy()`s them, so after the failure they still read `false` / `true` and
 *   keep accepting writes (and keep emitting `'error'`). Anything keyed on them never fires.
 *
 * With one listener attached, the `'error'` event has a handler, so it is no longer an `uncaughtException` —
 * the crash barrier is never re-entered by our own writes, and the loop (write → EIO → uncaughtException →
 * reportFault → write) is broken at its only edge.
 *
 * **Do NOT implement liveness by patching `write`.** `output-intercept.uninstall()`
 * (`output-intercept.ts:187`) does `Reflect.deleteProperty(stream, 'write')` — it would silently delete a
 * `write` patch installed here, and the liveness gate would vanish at exactly the moment (`shutdown()`)
 * the incident begins. The `'error'` event is a third, orthogonal channel that no `deleteProperty` can
 * touch:
 *
 * | Claimant                 | Channel                                                     | Removed by                  |
 * |--------------------------|-------------------------------------------------------------|-----------------------------|
 * | `output-intercept`       | OWN-property `write` on the stream instance (`:149`)         | `Reflect.deleteProperty` (`:187`) |
 * | `log-sink` / Ink         | PROTOTYPE `write` via Proxy, stepping over the own-property  | n/a (a Proxy, not a patch)  |
 * | `terminal-liveness`      | the **`'error'` event**                                      | `removeListener`            |
 *
 * ## Fatality is decided by STREAM IDENTITY, never by error code
 *
 * The listener is bound to the `process.stdout` / `process.stderr` OBJECTS. A handler writing to its own
 * client socket that hung up produces an `EPIPE` too — under a code-sniff, one user closing a browser tab
 * mid-request would kill the whole dev session, a worse fragility than the one the crash barrier removes.
 * Stream identity IS the proof that cannot happen.
 *
 * The one code-based rule permitted here is an EXCLUSION, not a selection: {@link TRANSIENT_CODES}
 * (`EAGAIN`, `EINTR`) are the only errnos that can mean "still alive" (libuv retries `EINTR` internally and
 * defers `EAGAIN` on pipes via `POLLOUT`; a TTY stdout is set blocking anyway). Everything else latches.
 *
 * ## The latch is right even when the terminal is fine
 *
 * With stdout redirected to a file, `process.stdout` is a `SyncWriteStream` and a failed `writeSync`
 * (`ENOSPC`, `EDQUOT`, `EFBIG`, `EBADF`) takes the SAME async `'error'` path. The latch is still correct —
 * stop writing to a stream that cannot be written to* holds whatever the cause — but the REPORT must name
 * the errno, never a story: `nohup ik dev > out.log` on a full disk is `ENOSPC`, and saying "the terminal is
 * gone" there would be a lie in the exact scenario (a disk-fill) this module exists to fix.
 */
import process from 'node:process'

/** Which of the two stdio streams died — carried into the reason string, never guessed at. */
export type StdioStreamName = 'stdout' | 'stderr'

/**
 * Errnos that do NOT mean the stream is gone. `EINTR` is retried inside libuv and `EAGAIN` is deferred via
 * `POLLOUT`, so neither should reach us at all — they are excluded as cheap insurance, and this exclusion is
 * the ONLY code-based logic in the module (see the doc block: fatality is stream identity, not error shape).
 */
const TRANSIENT_CODES = new Set(['EAGAIN', 'EINTR'])

export interface TerminalLivenessDeps {
  /**
   * The streams to own. Defaults to the real stdio pair. Injectable so a test can drive the real listener
   * with a fake stream instead of breaking the runner's own terminal.
   */
  streams?: NodeJS.WriteStream[]
  /**
   * Called at most ONCE, after the latch is already set. The reason a caller builds from it must name the
   * errno (`stdio unwritable: stdout ENOSPC`), never "the terminal is gone".
   */
  onDeath?: (stream: StdioStreamName, error: NodeJS.ErrnoException) => void
}

export interface TerminalLiveness {
  /** True once one of the owned streams has emitted a non-transient `'error'`. */
  isDead: () => boolean
  /** Detach the listeners and clear the latch. Production never calls it; it keeps tests hermetic. */
  uninstall: () => void
}

/**
 * Module-scoped so the write gates in `log-sink.ts` can read it without threading a handle through every
 * writer. Precedent: `dev-server.ts`'s module-scoped `logSink`, wired for exactly the same reason.
 */
let dead = false

/**
 * Has an owned stdio stream failed? The gate `rawStdoutWrite` / `rawStderrWrite` consult before every raw
 * terminal write — and the discriminator the crash barrier uses to decide fatal-vs-survive.
 */
export const isTerminalDead = (): boolean => {
  return dead
}

/** Identity first (the real streams), position as the fallback for injected fakes (`[stdout, stderr]`). */
const streamName = (stream: NodeJS.WriteStream, index: number): StdioStreamName => {
  if (stream === process.stdout) return 'stdout'
  if (stream === process.stderr) return 'stderr'

  return index === 1 ? 'stderr' : 'stdout'
}

/**
 * Install the one and only observer of stdio write failures.
 *
 * @example
 * const liveness = installTerminalLiveness({
 *   onDeath: (stream, error) => onFatal(`stdio unwritable: ${stream} ${error.code}`),
 * })
 */
export const installTerminalLiveness = ({
  streams = [process.stdout, process.stderr],
  onDeath,
}: TerminalLivenessDeps = {}): TerminalLiveness => {
  /** `onDeath` fires once, not once per stream: closing a terminal kills both fds at the same instant. */
  let fired = false
  const attached: { stream: NodeJS.WriteStream; listener: (error: unknown) => void }[] = []

  for (const [index, stream] of streams.entries()) {
    const name = streamName(stream, index)
    const listener = (raw: unknown): void => {
      const error = (raw ?? new Error('stdio error')) as NodeJS.ErrnoException

      if (error.code != null && TRANSIENT_CODES.has(error.code)) return

      // ORDER IS LOAD-BEARING: the latch closes BEFORE `onDeath` runs. `onDeath` leads to
      // `runner.shutdown()`, whose FIRST act is `renderer.dispose()` → `rerenderPersistent()`
      // (`persistent-ink-dev-ui.tsx:276-283`) — a write to this very stream. Latch second and teardown
      // begins by re-arming the thing it is tearing down.
      dead = true

      if (fired) return
      fired = true

      onDeath?.(name, error)
    }

    stream.on('error', listener)
    attached.push({ stream, listener })
  }

  return {
    isDead: () => {
      return dead
    },
    uninstall: () => {
      for (const { stream, listener } of attached) {
        stream.removeListener('error', listener)
      }
      attached.length = 0
      // Clearing the latch is what makes a test hermetic — a leaked `dead` would gate every raw write for
      // the rest of the worker. Nothing in production uninstalls: the dev process owns stdio until it exits.
      dead = false
      fired = false
    },
  }
}
