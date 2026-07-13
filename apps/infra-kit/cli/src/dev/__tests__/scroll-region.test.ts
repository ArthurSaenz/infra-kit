import { describe, expect, it } from 'vitest'

import {
  CLEAR_LINE,
  HIDE_CURSOR,
  RESTORE_CURSOR,
  SAVE_CURSOR,
  SHOW_CURSOR,
  installRegion,
  moveTo,
  paintFooter,
  reserveRows,
  resetScrollRegion,
  setScrollRegion,
} from '../scroll-region'

/**
 * Every builder is a pure string function; these assert the EXACT bytes so a stray escape can never
 * silently drift the terminal. `\x1B` is the ESC control char shared by all DEC/CSI sequences here.
 */
describe('scroll-region — pure ANSI builders', () => {
  it('emits the documented control-code constants verbatim', () => {
    expect(SAVE_CURSOR).toBe('\x1B7')
    expect(RESTORE_CURSOR).toBe('\x1B8')
    expect(CLEAR_LINE).toBe('\x1B[2K')
    expect(HIDE_CURSOR).toBe('\x1B[?25l')
    expect(SHOW_CURSOR).toBe('\x1B[?25h')
  })

  it('setScrollRegion / resetScrollRegion build DECSTBM sequences', () => {
    expect(setScrollRegion(1, 37)).toBe('\x1B[1;37r')
    expect(resetScrollRegion()).toBe('\x1B[r')
  })

  it('moveTo builds a 1-indexed absolute cursor move', () => {
    expect(moveTo(38, 1)).toBe('\x1B[38;1H')
    expect(moveTo(1, 1)).toBe('\x1B[1;1H')
  })

  it('reserveRows scrolls up n lines then moves the cursor back up n', () => {
    expect(reserveRows(3)).toBe('\n\n\n\x1B[3A')
    expect(reserveRows(1)).toBe('\n\x1B[1A')
  })

  it('reserveRows returns empty string for n <= 0', () => {
    expect(reserveRows(0)).toBe('')
    expect(reserveRows(-2)).toBe('')
  })

  it('paintFooter positions each line in the bottom rows, cursor-safe', () => {
    const out = paintFooter(['a', 'b'], 40)

    // Save cursor, paint rows 39 and 40 (each cleared first), restore cursor.
    expect(out).toBe(`${SAVE_CURSOR}\x1B[39;1H${CLEAR_LINE}a\x1B[40;1H${CLEAR_LINE}b${RESTORE_CURSOR}`)
  })

  it('paintFooter targets the last row for a single line', () => {
    expect(paintFooter(['only'], 24)).toBe(`${SAVE_CURSOR}\x1B[24;1H${CLEAR_LINE}only${RESTORE_CURSOR}`)
  })

  it('paintFooter returns empty string for no lines', () => {
    expect(paintFooter([], 40)).toBe('')
  })

  it('installRegion reserves the footer then confines scrolling above it', () => {
    // 40-row terminal, 3-row footer → reserve 3, scroll region 1..37.
    expect(installRegion(3, 40)).toBe(`\n\n\n\x1B[3A\x1B[1;37r`)
  })

  it('installRegion returns empty string when the terminal is too short', () => {
    // 3 rows, 3-row footer → no room for a scroll region (rows - footerHeight === 0 < 1).
    expect(installRegion(3, 3)).toBe('')
    expect(installRegion(5, 3)).toBe('')
  })
})
