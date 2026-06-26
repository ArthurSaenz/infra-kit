/**
 * Small shared rendering helpers for aligned terminal output. These replace
 * the ad-hoc "compute the max width, then padEnd each row" pattern that the
 * interactive menu (and similar list views) hand-rolled. Pure string helpers —
 * no I/O, no color — so they are trivially testable and reusable.
 */

/**
 * Align a list of two-column rows: pad every left cell to the widest left cell,
 * then join the two cells with `gap`. Returns one rendered line per row.
 *
 * @example
 * formatAlignedRows([['a', 'x'], ['bbb', 'y']])
 * // ['a    x', 'bbb  y']   (left padded to width 3, default 2-space gap)
 */
export const formatAlignedRows = (rows: ReadonlyArray<readonly [string, string]>, gap = '  '): string[] => {
  const width = rows.reduce((max, [left]) => {
    return Math.max(max, left.length)
  }, 0)

  return rows.map(([left, right]) => {
    return `${left.padEnd(width)}${gap}${right}`
  })
}
