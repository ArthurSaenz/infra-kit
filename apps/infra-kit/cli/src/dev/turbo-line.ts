/**
 * Turbo's `--ui=stream` line contract, shared by the UI engine (`ui-dev.ts`) and the log formatter
 * (`log-format.ts`). A leaf on purpose: both of those import it, and it imports neither.
 */

/** Turbo's per-task line prefix under `--ui=stream`: `<pkg>:dev:`. */
export const TASK_PREFIX = /^([^\s:]+):dev:[ \t]?/

/**
 * Vocabulary a framework uses to announce a failure on turbo's stream.
 *
 * Deliberately small and anchored, because the two errors are not symmetric: a miss costs an uncounted
 * error (the line is still in the log), while a false positive costs a red row over a healthy app. So
 * patterns must be specific, and every addition needs a real line that motivates it.
 */
// Why this reads the line's TEXT, when nothing else in the design does. Under `--ui=stream` turbo relays
// each task's stdout AND stderr onto its OWN stdout — measured, not assumed: a task writing one line to
// each fd yields both lines on turbo's fd 1, and fd 2 carries only turbo's chrome. So the fd that would
// otherwise DECLARE severity does not survive the relay: `child.stderr` never sees a single framework
// line, and a level counter built on it would be structurally, permanently zero. The panel would then show
// a green `client/ui` row over a UI that fails to compile — the one failure mode this whole design exists
// to prevent.
//
// This is not the residual-bucket guess that was rejected. That one asked "what IS this line?" of an
// unknown channel and promoted whatever it could not identify. This asks a narrower question of a KNOWN,
// declared format: turbo's `<pkg>:dev:` prefix contract is the same one already relied on to route the
// line to its package. The rule: classify only within a format you know; never guess about one you don't.
const ERROR_VOCABULARY = [
  /^error\b/i,
  // The glyphs get no `\b`: they are not word characters, so there is NO word boundary between `✘` and
  // the space that follows it — `✘\b` never matches the esbuild/vite lines it was aimed at. Anchoring
  // them alone is both correct and safe, since a line can only start with one by way of announcing a
  // failure.
  /^[✘✖×]/,
  /^\[vite\][^\n]*\berror\b/i,
  // A thrown JS error's first line (`TypeError: x is not a function`). ANCHORED, unlike a bare
  // `/\berror:/i`, which fires on any line merely containing `error:` — inside a URL, a JSON blob, or a
  // dev script's own echo.
  /^\w*Error: /,
  // `tsc`/`vue-tsc --watch` diagnostics: `src/foo.ts(3,5): error TS2322: …`. Matched explicitly because
  // NONE of the other patterns reach it — the line starts with a path, and `error` is followed by a
  // space, not a colon. Without this a `--watch` type-check task can fail to compile while its row on
  // the panel stays green, which is the exact lie this counter exists to prevent.
  /\berror TS\d+\b/,
  // Specific vite/esbuild failures, NOT a bare `^failed to`: that also matches the entirely benign
  // `Failed to load source map for …`, and a red row over a healthy app costs more trust than an
  // uncounted error costs information (the line is still in the log either way).
  /^Failed to (?:resolve|load url|parse|compile)\b/i,
  /^(?:ENOENT|EADDRINUSE|ECONNREFUSED)\b/,
  /pre-transform error/i,
  /\b(?:build|transform|compilation) failed\b/i,
  // NOTE: stack frames (`    at Module._compile (…)`) are deliberately NOT here. Matching them would
  // turn one thrown exception into one error per FRAME — a 20-frame stack reading as `⚠ 21`, at which
  // point the number stops being a count of anything. The throw's first line is already matched above.
] as const

/**
 * Severity of one framework line, from turbo's own relayed format. `error` when the framework announced
 * a failure in its output; `info` otherwise. See {@link ERROR_VOCABULARY} for why this cannot come from
 * the file descriptor.
 */
export const turboLineLevel = (text: string): 'info' | 'error' => {
  return ERROR_VOCABULARY.some((pattern) => {
    return pattern.test(text)
  })
    ? 'error'
    : 'info'
}

/**
 * The last redraw of a line a framework repainted with bare CR (a progress bar), or `null` when it was
 * drawn once. A trailing CR (a CRLF line end) is not a redraw. Turbo prefixes the line once, at its start,
 * so the prefix lives in the first segment and never in the returned one.
 *
 * @example
 * lastRedraw('shop-ui:dev: 10%\r50%\r100%') // => '100%'
 * lastRedraw('shop-ui:dev: ready\r')        // => null
 */
export const lastRedraw = (line: string): string | null => {
  if (!line.includes('\r')) return null

  const segments = line.split('\r').filter((segment) => {
    return segment !== ''
  })

  return segments.length > 1 ? (segments.at(-1) ?? null) : null
}
