/**
 * @fileoverview
 *
 * Pure viewport arithmetic shared by every Ink list screen (the command palette and both branch
 * pickers): which slice of the (already filtered) list fits the terminal, and how much chrome the
 * screen may spend around it.
 *
 * This is a SAFETY guard, not a readability one. Ink's cleanup walks the cursor upward one line at a
 * time (`ESC[2K ESC[1A` per row) and `ESC[1A` SATURATES AT ROW 0. So the moment a frame is taller than
 * the viewport, the terminal scrolls while Ink draws, the upward walk erases the wrong rows, and the
 * cursor is left parked ABOVE live content — after which every later write (the session's status
 * footer, the next palette frame) is deposited on top of the transcript. That is the "welded rows" bug:
 * `❯ ` printed over the head of `ERROR: …`, leaving `ROR: …` behind.
 *
 * The invariant this module exists to enforce, for every (columns, rows):
 *
 *     rendered frame height  <  terminal rows
 *
 * Hold that, and Ink never takes its overflow path: `clearTerminal` never fires, `eraseLines` never
 * saturates, the cursor stays below the transcript, and a fresh (cold) Ink instance — which erases
 * NOTHING before its first frame — simply appends below the transcript like any other CLI. No new
 * escape bytes required.
 *
 * Two things make the row count knowable at all:
 *   - Every list row is rendered `wrap="truncate"`, so one item is always exactly one row. Without that
 *     a long description wraps to two rows and this arithmetic silently under-counts (Ink wraps text
 *     itself and measures the WRAPPED height, so it, not us, would be right).
 *   - Chrome is counted unconditionally, even when a given row is not drawn (see `CHROME_ROWS`). Over-
 *     counting shrinks the list; under-counting overflows. Only one of those is a bug.
 *
 * `src/tui/safe-stderr.ts` (the `ESC[3J` byte filter) remains the last-resort backstop for the case
 * this cannot cover — a SIGWINCH that invalidates a frame's height retroactively.
 */
import type { PaletteItem } from '../types'

/**
 * Reads an item's group label. Omitted by the branch pickers, whose lists have no headers at all.
 * (Passed as an accessor rather than constrained with a `{ group?: string }` marker interface: a type
 * whose properties are ALL optional is "weak", and TypeScript refuses to match a `BranchPickerItem`
 * against it — inference silently falls back to the constraint and every field access breaks.)
 */
export type GroupOf<T> = (item: T) => string | undefined

/** The slice to render, plus how many rows fell off each end (for the `… n more` affordances). */
export interface ListWindow<T> {
  visible: T[]
  /** Index the window starts at — the component stores it so the list does not jump between frames. */
  start: number
  hiddenBefore: number
  hiddenAfter: number
}

/** Back-compat alias: the command palette's window is a window of `PaletteItem`s. */
export type PaletteWindow = ListWindow<PaletteItem>

/**
 * Rows a screen spends on everything that is not a list row, counted UNCONDITIONALLY (a `… n above`
 * that is not drawn today may be drawn on the next keystroke, and re-deriving the budget mid-frame is
 * how you get an off-by-one that only bites on a full list):
 *   hint, `❯` prompt, the list's `marginTop`, `… n above`, `… n below`, and one row of headroom.
 *
 * The headroom row is what makes the frame strictly SHORTER than the viewport: Ink treats a frame
 * exactly as tall as the terminal as fullscreen and clears the screen.
 */
export const CHROME_ROWS = 6

/** Compact chrome: the hint and the list's `marginTop` are dropped. Prompt + affordances + headroom. */
export const COMPACT_CHROME_ROWS = 4

/** Below this many rows a screen drops its hint, its `marginTop`, and its group headers. */
export const COMPACT_BELOW_ROWS = 10

/** Below this many rows no usable list fits at all; the screen renders a single-line notice instead. */
export const TINY_BELOW_ROWS = 5

/** How a screen must lay itself out to keep its frame shorter than `rows`. */
export type ListLayoutMode = 'full' | 'compact' | 'tiny'

export interface ListLayout {
  mode: ListLayoutMode
  /** Rows reserved for chrome. Pass to `paletteWindow` as `chromeRows`. */
  chromeRows: number
  /** Whether group headers may be drawn (they cost a row each, so a compact frame drops them). */
  groups: boolean
}

/** A list with no group headers: every item costs exactly one row. */
const NO_GROUPS = (): undefined => {
  return undefined
}

/**
 * The layout a screen must use at this terminal height. `extraChromeRows` is for chrome a screen has
 * that the others do not — the multi-picker's `select at least one` hint is the only one today.
 *
 * A `tiny` frame is one truncated line, which is strictly shorter than any terminal of 2+ rows. (At
 * `rows === 1` nothing can be shorter than the viewport; Ink will clear. That is a degenerate terminal,
 * and `safe-stderr` keeps even that harmless.)
 *
 * @example
 * listLayout(24)    // => { mode: 'full',    chromeRows: 6, groups: true }
 * listLayout(8)     // => { mode: 'compact', chromeRows: 4, groups: false }
 * listLayout(8, 1)  // => { mode: 'compact', chromeRows: 5, groups: false }  (multi-picker)
 * listLayout(4)     // => { mode: 'tiny',    chromeRows: 0, groups: false }
 */
export const listLayout = (rows: number, extraChromeRows = 0): ListLayout => {
  if (rows < TINY_BELOW_ROWS) {
    return { mode: 'tiny', chromeRows: 0, groups: false }
  }

  if (rows < COMPACT_BELOW_ROWS) {
    return { mode: 'compact', chromeRows: COMPACT_CHROME_ROWS + extraChromeRows, groups: false }
  }

  return { mode: 'full', chromeRows: CHROME_ROWS + extraChromeRows, groups: true }
}

/**
 * How many rows rendering `items[start..end)` costs: one per item (guaranteed by `wrap="truncate"`),
 * plus, when `groups` is on, one for each group header and one for the blank line between groups (the
 * first rendered group gets a header but no blank — it mirrors the `showGroup && position > 0` rule in
 * the components). A list whose items carry no `group` never spends a header row.
 */
const heightOf = <T>(items: T[], start: number, end: number, groupOf: GroupOf<T>): number => {
  let height = 0
  let previousGroup: string | undefined

  for (let index = start; index < end; index += 1) {
    const item = items[index]

    if (!item) break

    const group = groupOf(item)
    const startsGroup = group !== undefined && group !== previousGroup

    height += 1 + (startsGroup ? 1 : 0) + (startsGroup && index > start ? 1 : 0)
    previousGroup = group
  }

  return height
}

/** The last index (exclusive) that still fits `budget` rows when rendering from `start`. */
const endThatFits = <T>(items: T[], start: number, budget: number, groupOf: GroupOf<T>): number => {
  let end = start

  while (end < items.length && heightOf(items, start, end + 1, groupOf) <= budget) {
    end += 1
  }

  return end
}

/**
 * The window of items to render: the largest slice starting at or after `start` that fits the terminal
 * while still containing `activeIndex`. Scrolls by the minimum needed — the caller keeps `start` in
 * state, so the list only moves when the cursor would otherwise leave the window.
 *
 * An empty `visible` is a legitimate result on a terminal too short to hold even one row. It is NOT
 * clamped up to one item: forcing a row that does not fit is exactly how the frame overflows and the
 * cursor corruption starts. A screen that gets nothing back renders its `tiny` notice instead — see
 * `listLayout`.
 *
 * @example
 * const window = paletteWindow(items, 0, 12, 24)
 * window.visible.length // => however many commands fit 18 rows
 * window.hiddenAfter    // => the rest, surfaced as '… n below'
 */
export const paletteWindow = <T>(
  items: T[],
  start: number,
  activeIndex: number,
  rows: number,
  opts?: { chromeRows?: number; groupOf?: GroupOf<T> },
): ListWindow<T> => {
  const groupOf = opts?.groupOf ?? NO_GROUPS
  const budget = Math.max(0, rows - (opts?.chromeRows ?? CHROME_ROWS))

  // Scroll up only if the cursor moved above the window; otherwise scroll down just far enough.
  let first = Math.min(start, activeIndex)

  while (activeIndex >= endThatFits(items, first, budget, groupOf) && first < activeIndex) {
    first += 1
  }

  const end = endThatFits(items, first, budget, groupOf)

  return {
    visible: items.slice(first, end),
    start: first,
    hiddenBefore: first,
    hiddenAfter: Math.max(0, items.length - end),
  }
}
