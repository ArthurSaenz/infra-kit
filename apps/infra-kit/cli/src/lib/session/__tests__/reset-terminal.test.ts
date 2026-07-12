import { describe, expect, it, vi } from 'vitest'

import { resetTerminal } from '../reset-terminal'

/**
 * The alternate screen used to absorb whatever a dying child left on screen. Children now draw on the
 * primary screen (that is how their output survives), so the session has to clean up after them.
 */

const capture = (opts: { entersAltScreen?: boolean }, stdin = {}): string => {
  const out: string[] = []

  resetTerminal(opts, {
    write: (text) => {
      return out.push(text)
    },
    stdin,
  })

  return out.join('')
}

describe('resetTerminal', () => {
  it('returns the cursor to column 0 and makes it visible again', () => {
    const written = capture({})

    expect(written).toContain('\r')
    expect(written).toContain('[?25h')
  })

  it('resets colour, autowrap, and the scroll region a dead child may have left set', () => {
    const written = capture({})

    expect(written).toContain('[0m')
    expect(written).toContain('[?7h')
    // DECSTBM: a stuck scroll region traps every later line, including the palette.
    expect(written).toContain('[r')
  })

  it('does NOT leave the alternate screen for an ordinary command (we never entered it)', () => {
    expect(capture({})).not.toContain('[?1049l')
    expect(capture({ entersAltScreen: false })).not.toContain('[?1049l')
  })

  it('leaves the alternate screen for a command whose child owns it ($EDITOR killed mid-edit)', () => {
    expect(capture({ entersAltScreen: true })).toContain('[?1049l')
  })

  it('takes stdin out of raw mode when a killed child left it there', () => {
    const setRawMode = vi.fn()

    capture({}, { isTTY: true, isRaw: true, setRawMode })

    expect(setRawMode).toHaveBeenCalledWith(false)
  })

  it('leaves a clean stdin alone', () => {
    const setRawMode = vi.fn()

    capture({}, { isTTY: true, isRaw: false, setRawMode })

    expect(setRawMode).not.toHaveBeenCalled()
  })
})
