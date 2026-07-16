import { describe, expect, it } from 'vitest'

import { BRANCH_MULTI_PICKER_TEXT } from '../branch-multi-picker'
import { BRANCH_PICKER_TEXT } from '../branch-picker'
import { HINTS } from '../command-palette'

/** The common terminal width. Every screen string renders under `wrap="truncate"`. */
const MAX_COLUMNS = 80

const screens = {
  'branch-picker': BRANCH_PICKER_TEXT,
  'branch-multi-picker': BRANCH_MULTI_PICKER_TEXT,
  'command-palette': HINTS,
}

/**
 * Code points, NOT `.length`: `.length` counts UTF-16 units, so a single astral character
 * (an emoji in future copy) would count as 2 and overstate the width, failing the guard for
 * a string that actually fits. Today's copy is all BMP (`↑↓·—…❯`), so the two agree — the
 * spread is what keeps that true when the copy changes.
 *
 * This approximates display columns by code points, which holds because every character in
 * this copy is narrow. A double-width CJK glyph would need a real width table.
 */
const columns = (text: string): number => {
  return [...text].length
}

/**
 * `wrap="truncate"` silently eats the TAIL of an over-wide string, and the tail is exactly
 * where the Esc hint sits — so an over-long hint does not look broken, it just renders a
 * keybinding that the user can never see. `branch-multi-picker`'s hint shipped at 105 columns
 * for precisely that reason. This guard is the real one: ink-testing-library renders to a
 * STRING, never to a terminal, so no frame assertion can catch a hint that overflows.
 */
describe('screen hint widths', () => {
  for (const [screen, text] of Object.entries(screens)) {
    for (const [key, value] of Object.entries(text)) {
      it(`${screen}: ${key} fits in ${MAX_COLUMNS} columns`, () => {
        expect(columns(value)).toBeLessThan(MAX_COLUMNS)
      })
    }
  }
})
