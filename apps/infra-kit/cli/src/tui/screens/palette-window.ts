/**
 * Pure viewport arithmetic for the command palette: which slice of the (already filtered) command
 * list fits the terminal, given that a group header and a separator blank line each cost a row too.
 *
 * This is a READABILITY guard, not a safety one. A 25-command list is 33 rows and simply does not fit
 * an 80x24 terminal or a tmux split — and an Ink frame taller than the viewport also makes Ink erase
 * the screen on every keystroke. The guard that makes scrollback destruction *impossible* is the
 * `ESC[3J` filter in `src/tui/safe-stderr.ts`; windowing is what keeps the palette usable and the
 * frame stable. (It cannot be the safety guard: Ink re-renders on resize against a stale frame height,
 * and below a handful of rows no window is small enough.)
 */
import type { PaletteItem } from '../types'

/** The slice to render, plus how many rows fell off each end (for the `… n more` affordances). */
export interface PaletteWindow {
  visible: PaletteItem[]
  /** Index the window starts at — the component stores it so the list does not jump between frames. */
  start: number
  hiddenBefore: number
  hiddenAfter: number
}

/**
 * Rows the palette spends on anything that is not a command row: the hint, the prompt, the list's
 * `marginTop`, and the two `… n more` affordances. One extra row of headroom keeps the frame strictly
 * SHORTER than the viewport — Ink treats "exactly as tall as the terminal" as fullscreen and clears.
 */
const CHROME_ROWS = 6

/**
 * How many rows rendering `items[start..end)` costs: one per command, plus one for each group header
 * and one for each blank line between groups (the first rendered group gets a header but no blank —
 * it mirrors the `showGroup && position > 0` rule in the component).
 */
const heightOf = (items: PaletteItem[], start: number, end: number): number => {
  let height = 0
  let previousGroup = ''

  for (let index = start; index < end; index += 1) {
    const item = items[index]

    if (!item) break

    const startsGroup = item.group !== previousGroup

    height += 1 + (startsGroup ? 1 : 0) + (startsGroup && index > start ? 1 : 0)
    previousGroup = item.group
  }

  return height
}

/** The last index (exclusive) that still fits `budget` rows when rendering from `start`. */
const endThatFits = (items: PaletteItem[], start: number, budget: number): number => {
  let end = start

  while (end < items.length && heightOf(items, start, end + 1) <= budget) {
    end += 1
  }

  // Always show at least the active row, even on a terminal too short to hold it comfortably.
  return Math.max(end, start + 1)
}

/**
 * The window of commands to render: the largest slice starting at or after `start` that fits the
 * terminal while still containing `activeIndex`. Scrolls by the minimum needed — the caller keeps
 * `start` in state, so the list only moves when the cursor would otherwise leave the window.
 *
 * @example
 * const window = paletteWindow(items, 0, 12, 24)
 * window.visible.length // => however many commands fit 18 rows
 * window.hiddenAfter    // => the rest, surfaced as '… n more'
 */
export const paletteWindow = (
  items: PaletteItem[],
  start: number,
  activeIndex: number,
  rows: number,
): PaletteWindow => {
  const budget = Math.max(1, rows - CHROME_ROWS)

  // Scroll up only if the cursor moved above the window; otherwise scroll down just far enough.
  let first = Math.min(start, activeIndex)

  while (activeIndex >= endThatFits(items, first, budget) && first < activeIndex) {
    first += 1
  }

  const end = endThatFits(items, first, budget)

  return {
    visible: items.slice(first, end),
    start: first,
    hiddenBefore: first,
    hiddenAfter: Math.max(0, items.length - end),
  }
}
