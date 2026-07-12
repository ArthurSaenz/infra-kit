import { describe, expect, it } from 'vitest'

import type { PaletteItem } from '../../types'
import { paletteWindow } from '../palette-window'

/**
 * The palette must stay shorter than the terminal: a frame that fills the viewport makes Ink clear the
 * screen on every keystroke (harmless now that `safe-stderr` filters the scrollback-erasing escape,
 * but visually unusable). These tests pin the row arithmetic, including the rows spent on group
 * headers and the blank lines between groups.
 */

const item = (name: string, group: string): PaletteItem => {
  return { name, description: `run ${name}`, group }
}

/** The real shape of the catalog: three groups, 25 commands — 33 rows if rendered unwindowed. */
const catalog: PaletteItem[] = [
  ...Array.from({ length: 7 }, (_, i) => { return item(`release-${i}`, 'Release Management') }),
  ...Array.from({ length: 5 }, (_, i) => { return item(`worktrees-${i}`, 'Worktrees') }),
  ...Array.from({ length: 13 }, (_, i) => { return item(`env-${i}`, 'Environment') }),
]

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
    const view = paletteWindow(catalog, 0, 0, 24)
    // hint + prompt + marginTop + both '… n more' affordances.
    const chrome = 5

    expect(renderedHeight(view.visible) + chrome).toBeLessThan(24)
    expect(view.hiddenAfter).toBeGreaterThan(0)
  })

  it('shows every command when the terminal is tall enough', () => {
    const view = paletteWindow(catalog, 0, 0, 60)

    expect(view.visible).toHaveLength(catalog.length)
    expect(view.hiddenBefore).toBe(0)
    expect(view.hiddenAfter).toBe(0)
  })

  it('scrolls down just far enough to keep the cursor visible', () => {
    const view = paletteWindow(catalog, 0, 24, 24)
    const names = view.visible.map((entry) => { return entry.name })

    expect(names).toContain(catalog[24]?.name)
    expect(view.hiddenBefore).toBeGreaterThan(0)
  })

  it('scrolls back up when the cursor moves above the window', () => {
    const view = paletteWindow(catalog, 18, 2, 24)

    expect(view.start).toBe(2)
    expect(view.visible[0]?.name).toBe(catalog[2]?.name)
  })

  it('still renders the active row on a terminal too short to hold anything', () => {
    const view = paletteWindow(catalog, 0, 0, 4)

    expect(view.visible.length).toBeGreaterThanOrEqual(1)
  })

  it('handles an empty list (everything filtered out)', () => {
    const view = paletteWindow([], 0, 0, 24)

    expect(view.visible).toHaveLength(0)
    expect(view.hiddenAfter).toBe(0)
  })
})
