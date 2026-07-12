import process from 'node:process'

/**
 * The stream Ink renders into — stderr, with the one escape that can destroy the user's terminal
 * history filtered out.
 *
 * Ink erases the whole terminal whenever a frame overflows the viewport: `renderInteractiveFrame`
 * writes `ansiEscapes.clearTerminal`, which on POSIX is `ESC[2J ESC[3J ESC[H`. The middle one is
 * DECSED 3 — "erase saved lines" — and it wipes the SCROLLBACK BUFFER, not just the visible region.
 * The session shell puts every command's real output in that scrollback, so a palette frame taller
 * than the window (25 commands vs an 80x24 terminal or a tmux split) would erase the very transcript
 * the shell exists to produce, plus whatever the user had on screen before launching `infra-kit`.
 *
 * Bounding the frame height is NOT a sufficient guard: Ink re-renders on SIGWINCH using the PREVIOUS
 * frame's height against the NEW viewport, so shrinking the window trips the overflow check
 * retroactively, and no window fits a terminal of a handful of rows. So the guard is applied to the
 * bytes instead of the geometry — `ESC[3J` never reaches the terminal, whatever Ink decides to draw.
 * What survives (`ESC[2J ESC[H`: erase viewport, home cursor) is exactly Ink's intent.
 */

/** DECSED 3 — "erase saved lines". The only escape that can destroy scrollback. */
const ERASE_SCROLLBACK = /\u001B\[3J/g

/** Drop every scrollback-erasing escape from a frame. */
const scrub = (chunk: unknown): unknown => {
  return typeof chunk === 'string' ? chunk.replace(ERASE_SCROLLBACK, '') : chunk
}

/**
 * Wrap a stream so it can never erase scrollback. Everything except `write` is forwarded to the real
 * stream — Ink reads `columns`/`rows`/`isTTY` afresh on every frame and subscribes to `'resize'`, so
 * this must be a live view of the stream, not a snapshot of it.
 *
 * @example
 * const written: string[] = []
 * const safe = createSafeStream({ write: (s) => written.push(s) } as unknown as NodeJS.WriteStream)
 * safe.write('\u001B[2J\u001B[3J\u001B[H')
 * written[0] // => '\u001B[2J\u001B[H'  (the scrollback-erasing escape is gone)
 */
export const createSafeStream = (stream: NodeJS.WriteStream): NodeJS.WriteStream => {
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === 'write') {
        return (chunk: unknown, ...rest: unknown[]): boolean => {
          return (target.write as (...args: unknown[]) => boolean)(scrub(chunk), ...rest)
        }
      }

      const value = Reflect.get(target, property, receiver) as unknown

      // Methods must keep their original `this` (an EventEmitter bound to the proxy would register
      // listeners on the wrong object), so bind them back to the real stream.
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Ink's render target for the whole CLI: stderr, minus the scrollback-erasing escape. */
export const safeStderr = (): NodeJS.WriteStream => {
  return createSafeStream(process.stderr as unknown as NodeJS.WriteStream)
}
