/**
 * Pure, side-effect-free ANSI builders for a terminal SCROLL REGION (DECSTBM) sticky footer.
 *
 * `infra-kit dev` uses these to pin the ready-header block to the bottom of the terminal while a
 * `turbo run dev` UI child owns the same TTY via inherited stdio. DECSTBM (`ESC [ top ; bottom r`)
 * confines normal scrolling — from both the runner's own writes AND the inherited child's raw bytes —
 * to the region ABOVE the footer, so the footer rows are never scrolled away. That is why this works
 * where a piping approach could not: the child keeps inherited stdio and needs no per-framework flags.
 *
 * Every function here is a pure string builder: no I/O, no `process` access, no terminal queries. The
 * caller ({@link file://../tui/dev-ui/scroll-region-dev-ui.ts}) owns all writes, the row count, and the
 * TTY guard. Each builder is unit-tested with exact-string assertions.
 */

/** Save the cursor position (DECSC). Paired with {@link RESTORE_CURSOR} around a footer repaint. */
export const SAVE_CURSOR = '\x1B7'
/** Restore the cursor position saved by {@link SAVE_CURSOR} (DECRC). */
export const RESTORE_CURSOR = '\x1B8'
/** Erase the entire current line without moving the cursor (EL 2), so a repaint leaves no stale glyphs. */
export const CLEAR_LINE = '\x1B[2K'
/** Hide the cursor (DECTCEM off) — avoids a cursor flicker while the footer repaints. */
export const HIDE_CURSOR = '\x1B[?25l'
/** Show the cursor (DECTCEM on) — restored on teardown so the terminal is left usable. */
export const SHOW_CURSOR = '\x1B[?25h'

/**
 * Set the vertical scroll region (DECSTBM) to lines `top..bottom` inclusive, 1-indexed. Scrolling is
 * thereafter confined to that band; the rows below `bottom` become a static footer area.
 */
export const setScrollRegion = (top: number, bottom: number): string => {
  return `\x1B[${top};${bottom}r`
}

/** Reset the scroll region to the full screen (DECSTBM with no params) — the teardown counterpart. */
export const resetScrollRegion = (): string => {
  return '\x1B[r'
}

/** Absolute cursor move (CUP) to `row`,`col`, both 1-indexed. */
export const moveTo = (row: number, col: number): string => {
  return `\x1B[${row};${col}H`
}

/**
 * Scroll existing content up by `n` blank lines, then return the cursor to its starting row, so the
 * bottom `n` rows are cleared for a footer WITHOUT overwriting whatever was already on screen. Emits
 * `n` newlines (which scroll the viewport) followed by cursor-up-`n` (CUU). Returns `''` for `n <= 0`.
 */
export const reserveRows = (n: number): string => {
  if (n <= 0) return ''

  return `${'\n'.repeat(n)}\x1B[${n}A`
}

/**
 * Paint `lines` into the bottom `lines.length` rows of a `rows`-tall terminal, cursor-safe: save the
 * cursor, absolutely position + clear + write each line (top-most footer row first), then restore the
 * cursor so surrounding scroll output is undisturbed. Returns `''` when there are no lines to paint.
 */
export const paintFooter = (lines: readonly string[], rows: number): string => {
  if (lines.length === 0) return ''

  const base = rows - lines.length + 1
  const painted = lines
    .map((line, i) => {
      return `${moveTo(base + i, 1)}${CLEAR_LINE}${line}`
    })
    .join('')

  return `${SAVE_CURSOR}${painted}${RESTORE_CURSOR}`
}

/**
 * Reserve `footerHeight` rows at the bottom and confine scrolling to the rows above them: emit
 * {@link reserveRows} then a {@link setScrollRegion} of `1..rows - footerHeight`. Returns `''` when the
 * terminal is too short to host both a scroll region and the footer (`rows - footerHeight < 1`); the
 * caller MUST treat `''` as "skip the whole feature" and fall back to a one-shot plain print.
 */
export const installRegion = (footerHeight: number, rows: number): string => {
  if (rows - footerHeight < 1) return ''

  return `${reserveRows(footerHeight)}${setScrollRegion(1, rows - footerHeight)}`
}
