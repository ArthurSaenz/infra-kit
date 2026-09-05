/*
 * This module's entire job is to take ownership of the global `console`, so it necessarily names every
 * console method — including the ones `no-console` exists to keep out of application code. The rule is
 * disabled here and NOWHERE else: any other file reaching for `console.log` should still be stopped.
 */
/* eslint-disable no-console */
/**
 * @fileoverview
 *
 * Routes every line the dev process emits into the per-service log files, so the terminal can be given
 * over entirely to the status panel.
 *
 * ## Why this has to exist
 *
 * The backend runs IN-PROCESS: `ServerlessLocalRun` is fastify + `@aws-lambda-powertools/logger` in the
 * same node process, and the runner sets `POWERTOOLS_DEV=true`, which makes Powertools bind the GLOBAL
 * `console`. So a handler's `console.log` AND every Powertools line reach `process.stdout` through
 * channels no seam of ours owns. There is no other place to catch them. (Reassigning the Powertools
 * `Logger`'s console does NOT work: handlers are given a `createChild()` logger, and `createChild`
 * re-derives its console from the global — the parent's is never consulted.)
 *
 * ## Why this is not the classifier that was rejected
 *
 * An earlier design tried to decide, per line, whether to PRINT it — inferring "whatever is left on
 * stdout must be human, therefore promote it". That was unsound: the residual bucket also holds the
 * env-gated raw request line, dependency import banners, and Node's own warnings, so the rule promoted
 * exactly the noise it meant to hide. There is no such decision here. **Every line goes to a file** —
 * one rule, no residue, nothing to be wrong about. The only thing read is DECLARED provenance: which
 * `console` method the caller chose, and which fd it wrote to. The line's bytes are never inspected.
 *
 * ## One switch, not two: NOTHING is ever echoed
 *
 * The sink installs EARLY (at process start) and is file-only from the first byte. There is no tee
 * window and no "print until `ready()`" phase: an app's log line NEVER reaches the terminal, at any
 * point in the process's life. That is the whole product decision — the terminal belongs to the panel.
 *
 * The tee that used to exist was justified by one fear: that a boot crash would vanish into a log file
 * and leave the user staring at a blank screen. That fear is unfounded, and each of the three ways a
 * dev session can die is covered WITHOUT echoing a single log line:
 *
 * 1. An uncaught exception / rejection during boot. Node's fatal report is written STRAIGHT TO FD 2 by
 *    the runtime — it never goes through `process.stderr.write`, so the patch below cannot swallow it.
 *    (Verified, not assumed: patch `stderr.write`, throw, and the stack still prints while the patch
 *    counts zero chunks.)
 * 2. A boot failure that rejects `run()`. `shutdown()` calls {@link OutputIntercept.uninstall} BEFORE
 *    anything prints, so the error surfaces from the entry point's top-level catch on a clean stderr.
 * 3. A fault after `ready()`. The crash barrier routes it to `DevServerRunner.reportFault`, which files
 *    it at `error` (turning the row red) AND paints it through the panel's bypass.
 *
 * So a crash is never silent, and a LOG is never printed. Those were always two separate jobs; the tee
 * conflated them, and the price was a Powertools `Server listening` banner printed above the panel.
 *
 * ## Anti-recursion
 *
 * The panel writes to the terminal through {@link rawStdoutWrite}, which resolves `write` off the
 * PROTOTYPE and so steps over the own-property patch installed here. The interceptor's only sink is a
 * file. The failure mode to guard against is not a stack overflow — it is a BLACK HOLE: hand the panel
 * a patched stream and its frames are quietly filed into a log instead of drawn.
 */
import process from 'node:process'
import util from 'node:util'

import type { DevLogSink } from './log-sink.js'
import type { LogLevel } from './render.js'

/** The `console` methods that reach a terminal, each with the level its NAME declares. */
const CONSOLE_LEVELS = {
  log: 'info',
  info: 'info',
  debug: 'debug',
  trace: 'debug',
  warn: 'warn',
  error: 'error',
} as const satisfies Record<string, LogLevel>

type ConsoleMethod = keyof typeof CONSOLE_LEVELS

export interface OutputInterceptOptions {
  /** Where every captured line is filed. */
  sink: DevLogSink
  /** The service to file a line under when nothing else claims it. A NAMED bucket, never a guess. */
  fallbackService: string
  /** The service owning the current async context, if any (the `AsyncLocalStorage` lookup). */
  currentService: () => string | undefined
}

export interface OutputIntercept {
  /** Restore `console` and the raw stream writes to exactly what they were. Idempotent. */
  uninstall: () => void
}

/**
 * Install the interception. Every captured line goes to a FILE and only to a file — there is no
 * terminal echo at any point. Call {@link OutputIntercept.uninstall} on every exit path, BEFORE
 * anything else prints.
 *
 * Never install this on a non-TTY / `--json` / MCP run: it would file the machine-readable stream into
 * a log and hand the caller an empty stdout. The caller owns that gate.
 */
export const installOutputIntercept = ({
  sink,
  fallbackService,
  currentService,
}: OutputInterceptOptions): OutputIntercept => {
  let live = true

  const serviceFor = (): string => {
    return currentService() ?? fallbackService
  }

  /** File a line. There is no second destination: the terminal belongs to the panel. */
  const capture = (text: string, level: LogLevel): void => {
    sink.write(serviceFor(), text, { level })
  }

  // ---- console ------------------------------------------------------------
  //
  // The console patches do NOT delegate to the original methods. They must not: `console.log` writes
  // through `process.stdout.write`, which is patched below, so delegating would file every console line
  // TWICE and double every counter. Routing them straight to the sink also preserves the one thing the
  // raw-stream patch cannot see — the level the caller DECLARED by picking `warn` over `log`.
  const originalConsole = {} as Record<ConsoleMethod, (...args: unknown[]) => void>

  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    originalConsole[method] = console[method] as (...args: unknown[]) => void
    console[method] = (...args: unknown[]): void => {
      if (!live) {
        originalConsole[method](...args)

        return
      }
      capture(util.format(...args), CONSOLE_LEVELS[method])
    }
  }

  // ---- raw stream writes --------------------------------------------------
  //
  // What is left after the console patch: writes that bypass `console` entirely — the env-gated raw
  // request line, a dependency's import-time banner, and `process.emitWarning` (which goes to stderr,
  // NOT through `console.warn`). Chunk-oriented, so they are line-buffered before being filed.
  const patchStream = (stream: NodeJS.WriteStream, level: LogLevel): (() => void) => {
    const original = stream.write.bind(stream)
    let pending = ''

    const flush = (): void => {
      if (pending === '') return
      sink.write(serviceFor(), pending, { level })
      pending = ''
    }

    stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      if (!live || typeof chunk !== 'string') {
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
      }

      pending += chunk

      const lines = pending.split('\n')

      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line !== '') sink.write(serviceFor(), line, { level })
      }

      // A chunk that never ends in a newline (a progress line, a prompt) would otherwise be held
      // forever; flush it once it is clearly not a partial line.
      if (pending.length > 8192) flush()

      // Honour the stream contract's completion callback — `write(chunk, cb)` and `write(chunk, enc, cb)`
      // both promise to call it. Swallowing it hangs any caller that awaits the write before proceeding
      // (a logger flushing before exit, a promisified write), and it would hang inside a dev session
      // whose terminal shows nothing but a frozen panel. Deferred, exactly as a real stream defers it.
      const callback = rest.find((arg) => {
        return typeof arg === 'function'
      })

      if (typeof callback === 'function') {
        process.nextTick(callback as () => void)
      }

      return true
    }) as NodeJS.WriteStream['write']

    return (): void => {
      flush()
      // Delete the own-property patch rather than reassigning the original: reassigning would leave a
      // second own property in place, and `hasForeignStdoutPatch` (and the next installer) would still
      // see a patched stream.
      Reflect.deleteProperty(stream, 'write')
    }
  }

  // stderr is levelled `warn`, not `error`: `process.emitWarning` is far and away its highest-volume
  // user, and a genuine fault does not rely on this level — the crash barrier reports through
  // `DevServerRunner.reportFault`, which files at `error` AND punches the stack onto the terminal.
  // Neither stream is echoed anywhere: a level here decides which FILE bucket and which counter a line
  // lands in, nothing more.
  const restoreStdout = patchStream(process.stdout, 'info')
  const restoreStderr = patchStream(process.stderr, 'warn')

  return {
    uninstall: (): void => {
      if (!live) return
      live = false
      restoreStdout()
      restoreStderr()
      for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
        console[method] = originalConsole[method] as typeof console.log
      }
    },
  }
}
