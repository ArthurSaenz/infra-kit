import { describe, expect, it } from 'vitest'

import { InvalidReleaseDateError, assertIsoDate, isIsoDate, isoDateSchema } from '../release-date'

/**
 * No `process.env.TZ` mutation anywhere in here: `TZ` is worker-global under vitest, and the
 * validator is timezone-independent by construction (UTC in, UTC out). The calendar cases below
 * pass or fail identically in every zone, which is the property being pinned.
 */

describe('isIsoDate', () => {
  it.each(['2026-10-28', '2024-02-29', '2026-01-01', '2026-12-31'])('accepts %s', (raw) => {
    expect(isIsoDate(raw)).toBe(true)
  })

  it.each(['2026-1-5', '28/10/2026', '20261028', '2026-10-28T00:00:00Z', '28-10-2026', '', 'next'])(
    'rejects the shape %j',
    (raw) => {
      expect(isIsoDate(raw)).toBe(false)
    },
  )

  // Shape-valid, calendar-invalid: the regex alone would let every one of these through.
  it.each(['2026-02-30', '2026-13-01', '2023-02-29', '2026-00-10', '2026-04-31'])(
    'rejects the impossible calendar date %s',
    (raw) => {
      expect(isIsoDate(raw)).toBe(false)
    },
  )

  it('does not trim — trimming is assertIsoDate’s job', () => {
    expect(isIsoDate(' 2026-10-28')).toBe(false)
  })
})

describe('assertIsoDate', () => {
  it('trims and returns the canonical string', () => {
    expect(assertIsoDate('  2026-10-28 ')).toBe('2026-10-28')
  })

  it('throws InvalidReleaseDateError naming the offender and the expected form', () => {
    let thrown: unknown

    try {
      assertIsoDate('28-10-2026')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(InvalidReleaseDateError)
    expect((thrown as Error).message).toBe('Release date "28-10-2026" is not a calendar date in yyyy-mm-dd form.')
  })

  it('names the trimmed offender, not the padded input', () => {
    expect(() => {
      return assertIsoDate(' 2026-02-30 ')
    }).toThrow('Release date "2026-02-30" is not a calendar date in yyyy-mm-dd form.')
  })
})

describe('isoDateSchema', () => {
  it('accepts a calendar date and refuses a shape-valid impossible one', () => {
    expect(isoDateSchema.safeParse('2026-10-28').success).toBe(true)
    expect(isoDateSchema.safeParse('2026-02-30').success).toBe(false)
  })
})
