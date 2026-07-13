import { describe, expect, it } from 'vitest'

import type { PaletteItem } from '../../types'
import { CHROME_ROWS, listLayout, paletteWindow } from '../palette-window'

/**
 * The palette must stay strictly shorter than the terminal. This is a SAFETY guard, not a readability
 * one: an overflowing Ink frame makes the terminal scroll mid-draw, which makes Ink's upward
 * `eraseLines` walk saturate at row 0, which leaves the cursor parked above live content — after which
 * the session's footer and the next frame are welded onto the command's own output. These tests pin the
 * row arithmetic, including the rows spent on group headers and the blank lines between groups.
 *
 * Height alone is not the whole invariant — one item must also be exactly one ROW, which is what
 * `wrap="truncate"` buys. That half is pinned in `frame-height.test.tsx`, against the real Ink renderer.
 */

const item = (name: string, group: string): PaletteItem => {
  return { name, description: `run ${name}`, group }
}

/** The real shape of the catalog: three groups, 25 commands — 33 rows if rendered unwindowed. */
const catalog: PaletteItem[] = [
  ...Array.from({ length: 7 }, (_, i) => {
    return item(`release-${i}`, 'Release Management')
  }),
  ...Array.from({ length: 5 }, (_, i) => {
    return item(`worktrees-${i}`, 'Worktrees')
  }),
  ...Array.from({ length: 13 }, (_, i) => {
    return item(`env-${i}`, 'Environment')
  }),
]

/** The palette's group accessor — the same one the component passes. */
const groupOf = (entry: PaletteItem): string => {
  return entry.group
}

/** Rows the visible slice costs: one per command, plus a header per group and a blank between groups. */
const renderedHeight = (visible: PaletteItem[]): number => {
  let height = 0
  let previousGroup = ''

  visible.forEach((entry, position) => {
    const startsGroup = entry.group !== previousGroup

    height += 1 + (startsGroup ? 1 : 0) + (startsGroup && position > 0 ? 1 : 0)
    previousGroup = entry.group
  })

  return height
}

describe('paletteWindow', () => {
  it('keeps the whole frame strictly shorter than the viewport on an 80x24 terminal', () => {
    const view = paletteWindow(catalog, 0, 0, 24, { groupOf })
    // hint + prompt + marginTop + both '… n more' affordances.
    const chrome = 5

    expect(renderedHeight(view.visible) + chrome).toBeLessThan(24)
    expect(view.hiddenAfter).toBeGreaterThan(0)
  })

  it('shows every command when the terminal is tall enough', () => {
    const view = paletteWindow(catalog, 0, 0, 60, { groupOf })

    expect(view.visible).toHaveLength(catalog.length)
    expect(view.hiddenBefore).toBe(0)
    expect(view.hiddenAfter).toBe(0)
  })

  it('scrolls down just far enough to keep the cursor visible', () => {
    const view = paletteWindow(catalog, 0, 24, 24, { groupOf })
    const names = view.visible.map((entry) => {
      return entry.name
    })

    expect(names).toContain(catalog[24]?.name)
    expect(view.hiddenBefore).toBeGreaterThan(0)
  })

  it('scrolls back up when the cursor moves above the window', () => {
    const view = paletteWindow(catalog, 18, 2, 24, { groupOf })

    expect(view.start).toBe(2)
    expect(view.visible[0]?.name).toBe(catalog[2]?.name)
  })

  it('charges no header rows for a list without groups (the branch pickers)', () => {
    const branches = Array.from({ length: 30 }, (_, i) => {
      return { label: `release/v1.${i}.0`, value: `release/v1.${i}.0` }
    })
    const view = paletteWindow(branches, 0, 0, 24, { chromeRows: CHROME_ROWS })

    // 24 rows − 6 chrome = 18 branches, one row each. A header charge would make this 17 or fewer.
    expect(view.visible).toHaveLength(18)
    expect(view.hiddenAfter).toBe(12)
  })

  it('returns an empty window rather than forcing a row that does not fit', () => {
    // The old behaviour clamped this up to one item, which cost 2 rows (item + its group header) on a
    // 4-row terminal — i.e. it manufactured the very overflow this module exists to prevent. A screen
    // that gets nothing back renders its one-line `tiny` notice instead (see `listLayout`).
    const view = paletteWindow(catalog, 0, 0, 4, { groupOf })

    expect(view.visible).toHaveLength(0)
  })

  it('never exceeds its row budget at any terminal height', () => {
    for (let rows = 1; rows <= 40; rows += 1) {
      const layout = listLayout(rows)
      const view = paletteWindow(catalog, 0, 0, rows, {
        chromeRows: layout.chromeRows,
        groupOf: layout.groups ? groupOf : undefined,
      })
      const budget = Math.max(0, rows - layout.chromeRows)
      const height = layout.groups
        ? renderedHeight(view.visible)
        : // Compact frames draw no headers, so each item is exactly one row.
          view.visible.length

      expect(height).toBeLessThanOrEqual(budget)
    }
  })

  it('handles an empty list (everything filtered out)', () => {
    const view = paletteWindow([], 0, 0, 24, { groupOf })

    expect(view.visible).toHaveLength(0)
    expect(view.hiddenAfter).toBe(0)
  })
})

describe('listLayout', () => {
  it('drops the hint, the marginTop and the group headers before it drops the list', () => {
    expect(listLayout(24)).toEqual({ mode: 'full', chromeRows: 6, groups: true })
    expect(listLayout(8)).toEqual({ mode: 'compact', chromeRows: 4, groups: false })
    // The multi-picker's 'select at least one' hint is chrome too, counted whether or not it is drawn.
    expect(listLayout(8, 1)).toEqual({ mode: 'compact', chromeRows: 5, groups: false })
  })

  it('falls back to a one-line notice on a terminal too short for any list', () => {
    expect(listLayout(4).mode).toBe('tiny')
    expect(listLayout(1).mode).toBe('tiny')
  })
})
