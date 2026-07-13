import { describe, expect, it } from 'vitest'

import { clampFooter } from '../live-region.js'

describe('clampFooter', () => {
  it('returns lines unchanged when under the cap, at the cap, or when no cap is given', () => {
    const lines = ['a', 'b', 'c']

    expect(clampFooter(lines)).toEqual(lines)
    expect(clampFooter(lines, 5)).toEqual(lines)
    expect(clampFooter(lines, 3)).toEqual(lines)
  })

  it('collapses the overflow into one trailing "… +N more" line (result length === cap)', () => {
    const lines = ['a', 'b', 'c', 'd', 'e']

    expect(clampFooter(lines, 3)).toEqual(['a', 'b', '  … +3 more'])
  })

  it('treats a cap below 1 as no cap (never renders a bare "… +N more")', () => {
    const lines = ['a', 'b']

    expect(clampFooter(lines, 0)).toEqual(lines)
  })
})
