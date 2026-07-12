import process from 'node:process'

/**
 * Terminal hygiene between a finished child and the next palette frame.
 *
 * A child that dies mid-draw — a SIGINT'd `gh` progress spinner, a crashed pager — leaves the terminal
 * dirty: cursor hidden, SGR colour still set, autowrap off, the cursor parked mid-line, or a scroll
 * region (DECSTBM) still installed. The session used to run children inside the alternate screen
 * buffer, so all of that was discarded with the buffer on exit. Now that children draw on the primary
 * screen — which is the point, it is how their output survives — nobody discards it, and the next
 * status footer would be welded onto a half-written line inside a broken scroll region.
 *
 * So the session cleans up after every child, not just cancelled ones. `?1049l` is NOT sent for
 * ordinary commands (we never entered the alternate screen for them); it is sent only for a command
 * whose child enters it itself and may have died before restoring the primary buffer.
 */

/** The escapes that put a terminal back into a sane state, in the order they must be applied. */
const ANSI = {
  /** Return to column 0 — a child may have exited mid-line. */
  column: '\r',
  /** Reset SGR: colour, bold, inverse. */
  sgr: '\u001B[0m',
  /** Show the cursor (a TUI child may have hidden it). */
  cursor: '\u001B[?25h',
  /** Re-enable autowrap (DECAWM). */
  wrap: '\u001B[?7h',
  /** Reset the scroll region to the full screen (DECSTBM) — a stuck region traps all later output. */
  scrollRegion: '\u001B[r',
  /** Leave the alternate screen — only for a child that entered it and may not have left it. */
  primaryBuffer: '\u001B[?1049l',
}

export interface ResetTerminalDeps {
  write?: (text: string) => void
  /** Take stdin out of raw mode if a dead child left it there. Defaults to `process.stdin`. */
  stdin?: { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => void }
}

/**
 * Put the terminal back in a usable state after a child exits. Safe to call unconditionally: every
 * escape is a no-op on a terminal that was already clean.
 *
 * @example
 * const out: string[] = []
 * resetTerminal({ entersAltScreen: false }, { write: (s) => out.push(s), stdin: {} })
 * out.join('') // => '\r\u001B[0m\u001B[?25h\u001B[?7h\u001B[r'
 */
export const resetTerminal = (opts: { entersAltScreen?: boolean }, deps?: ResetTerminalDeps): void => {
  const write =
    deps?.write ??
    ((text: string) => {
      process.stderr.write(text)
    })
  const stdin = deps?.stdin ?? process.stdin

  const escapes = [ANSI.column, ANSI.sgr, ANSI.cursor, ANSI.wrap, ANSI.scrollRegion]

  // Only for a child that owns the alternate screen: if it was killed before restoring the primary
  // buffer, everything we draw next would land in a buffer the terminal is about to throw away.
  if (opts.entersAltScreen === true) escapes.push(ANSI.primaryBuffer)

  write(escapes.join(''))

  // A child killed mid-prompt can leave the tty in raw mode, which would eat the palette's keystrokes.
  if (stdin.isTTY === true && stdin.isRaw === true) stdin.setRawMode?.(false)
}
