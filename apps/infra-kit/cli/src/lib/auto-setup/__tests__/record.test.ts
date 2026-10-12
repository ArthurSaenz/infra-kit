import { describe, expect, it } from 'vitest'

import {
  AUTO_SETUP_COOLDOWN_MS,
  MAX_AUTO_SETUP_ATTEMPTS,
  autoSetupDue,
  readAutoSetupRecord,
  readNotifiedMarker,
} from '../record'
import type { AutoSetupRecord } from '../record'

const STARTED = 1_770_000_000_000
const LATER = STARTED + AUTO_SETUP_COOLDOWN_MS

const record = (overrides: Partial<AutoSetupRecord> = {}): AutoSetupRecord => {
  return {
    version: '0.19.0',
    attempts: 1,
    startedMs: STARTED,
    finishedMs: STARTED + 1_000,
    runs: [{ root: null, status: 'ok', notes: [] }],
    ...overrides,
  }
}

const failed = { runs: [{ root: '/p', status: 'failed' as const, notes: ['boom'] }] }

describe('autoSetupDue', () => {
  it('is owed on a first run and after any version change', () => {
    expect(autoSetupDue(null, '0.19.0', LATER)).toBe(true)
    expect(autoSetupDue(record({ version: '0.18.1' }), '0.19.0', LATER)).toBe(true)
  })

  it('is not owed again for a version that finished, attention included', () => {
    expect(autoSetupDue(record(), '0.19.0', LATER)).toBe(false)
    expect(autoSetupDue(record({ runs: [{ root: '/p', status: 'attention', notes: ['x'] }] }), '0.19.0', LATER)).toBe(
      false,
    )
  })

  it('retries a failed or unfinished pass until the attempts run out', () => {
    expect(autoSetupDue(record({ ...failed, attempts: MAX_AUTO_SETUP_ATTEMPTS - 1 }), '0.19.0', LATER)).toBe(true)
    expect(autoSetupDue(record({ finishedMs: null, runs: [] }), '0.19.0', LATER)).toBe(true)
    expect(autoSetupDue(record({ ...failed, attempts: MAX_AUTO_SETUP_ATTEMPTS }), '0.19.0', LATER)).toBe(false)
  })

  // Reds on: two binaries on PATH alternating versions, each pass reading the other's record as "new".
  it('holds every pass inside the cooldown, a version change included', () => {
    const inside = STARTED + AUTO_SETUP_COOLDOWN_MS - 1

    expect(autoSetupDue(record({ version: '0.18.1' }), '0.19.0', inside)).toBe(false)
    expect(autoSetupDue(record({ ...failed }), '0.19.0', inside)).toBe(false)
  })

  it('does not let a future startedMs (clock skew) hold the cooldown', () => {
    expect(
      autoSetupDue(record({ version: '0.18.1', startedMs: STARTED + 10 * AUTO_SETUP_COOLDOWN_MS }), '0.19.0', LATER),
    ).toBe(true)
  })
})

describe('readAutoSetupRecord', () => {
  it('returns null for a missing, corrupt or wrong-shaped file — never throws', () => {
    expect(
      readAutoSetupRecord(() => {
        throw new Error('ENOENT')
      }),
    ).toBeNull()
    expect(
      readAutoSetupRecord(() => {
        return '{not json'
      }),
    ).toBeNull()
    expect(
      readAutoSetupRecord(() => {
        return JSON.stringify({ ...record(), runs: [{ root: null, status: 'exploded', notes: [] }] })
      }),
    ).toBeNull()
  })

  it('round-trips a finished and a provisional record', () => {
    expect(
      readAutoSetupRecord(() => {
        return JSON.stringify(record())
      }),
    ).toEqual(record())
    expect(
      readAutoSetupRecord(() => {
        return JSON.stringify(record({ finishedMs: null, runs: [] }))
      }),
    ).toEqual(record({ finishedMs: null, runs: [] }))
  })
})

describe('readNotifiedMarker', () => {
  it('reads the marked finishedMs, and null for a missing or garbled marker', () => {
    expect(
      readNotifiedMarker(() => {
        return '1770000001000\n'
      }),
    ).toBe(1_770_000_001_000)
    expect(
      readNotifiedMarker(() => {
        throw new Error('ENOENT')
      }),
    ).toBeNull()
    expect(
      readNotifiedMarker(() => {
        return 'garbage'
      }),
    ).toBeNull()
  })
})
