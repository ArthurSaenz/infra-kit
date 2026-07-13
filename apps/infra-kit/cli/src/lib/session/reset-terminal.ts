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
  /** Save the cursor position (DECSC). See `scrollRegion`. */
  saveCursor: '\u001B7',
  /** Restore the cursor position saved by DECSC (DECRC). See `scrollRegion`. */
  restoreCursor: '\u001B8',
  /**
   * Reset the scroll region to the full screen (DECSTBM) — a stuck region traps all later output.
   *
   * DECSTBM ALSO HOMES THE CURSOR. That is not a quirk, it is the spec, and it is why this escape must
   * always be bracketed by DECSC/DECRC. Sent bare, it moved the cursor to the top-left after EVERY
   * child — so the status footer, and then the next palette frame, were drawn from row 1 straight over
   * the command's own output. That is the whole "welded rows" bug: `✓ ok · 2.9s` printed on top of an
   * unrelated line, and the palette's `❯ ` printed over the head of the command's own `ERROR:` line,
   * leaving `❯ ROR: …` behind.
   */
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
 * out.join('') // => '\u001B7\u001B[r\u001B8\r\u001B[0m\u001B[?25h\u001B[?7h'
 */
export const resetTerminal = (opts: { entersAltScreen?: boolean }, deps?: ResetTerminalDeps): void => {
  const write =
    deps?.write ??
    ((text: string) => {
      process.stderr.write(text)
    })
  const stdin = deps?.stdin ?? process.stdin

  // DECSTBM homes the cursor, so the scroll-region reset is bracketed by save/restore: the cursor must
  // end up exactly where the child left it — below the child's output — or everything written next (the
  // footer, the next palette frame) lands on top of that output instead of after it.
  const escapes = [
    ANSI.saveCursor,
    ANSI.scrollRegion,
    ANSI.restoreCursor,
    ANSI.column,
    ANSI.sgr,
    ANSI.cursor,
    ANSI.wrap,
  ]

  // Only for a child that owns the alternate screen: if it was killed before restoring the primary
  // buffer, everything we draw next would land in a buffer the terminal is about to throw away.
  if (opts.entersAltScreen === true) escapes.push(ANSI.primaryBuffer)

  write(escapes.join(''))

  // A child killed mid-prompt can leave the tty in raw mode, which would eat the palette's keystrokes.
  if (stdin.isTTY === true && stdin.isRaw === true) stdin.setRawMode?.(false)
}
