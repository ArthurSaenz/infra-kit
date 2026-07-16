import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CACHE_FILE_NAME,
  CHECK_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  cacheFilePath,
  isStale,
  readUpdateCache,
  writeUpdateCache,
} from '../update-cache'

const NOW = 1_770_000_000_000

let cacheHome = ''
let previousXdg: string | undefined

beforeEach(() => {
  previousXdg = process.env.XDG_CACHE_HOME
  cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-update-cache-'))
  // getCacheRoot() resolves $XDG_CACHE_HOME/infra-kit, so this sandboxes the real ~/.cache.
  process.env.XDG_CACHE_HOME = cacheHome
})

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = previousXdg

  fs.rmSync(cacheHome, { force: true, recursive: true })
})

describe('writeUpdateCache', () => {
  it('creates the cache root when it does not exist', () => {
    // atomicWriteFileSync writes a temp file beside the target and renames; without an mkdir it throws
    // ENOENT on a fresh machine, lastCheckMs never lands, and every command spawns a detached child.
    expect(fs.existsSync(path.join(cacheHome, 'infra-kit'))).toBe(false)

    writeUpdateCache({ lastCheckMs: NOW, latestVersion: '0.1.131', updateCommand: null })

    expect(readUpdateCache()).toEqual({ lastCheckMs: NOW, latestVersion: '0.1.131', updateCommand: null })
  })

  it('writes the file 0600 and leaves no temp file behind', () => {
    writeUpdateCache({ lastCheckMs: NOW, latestVersion: null, updateCommand: null })

    const root = path.join(cacheHome, 'infra-kit')

    expect(fs.readdirSync(root)).toEqual([CACHE_FILE_NAME])
    expect(fs.statSync(cacheFilePath()).mode & 0o777).toBe(0o600)
  })

  it('overwrites an existing cache', () => {
    writeUpdateCache({ lastCheckMs: 1, latestVersion: '0.1.131', updateCommand: null })
    writeUpdateCache({ lastCheckMs: NOW, latestVersion: null, updateCommand: null })

    expect(readUpdateCache()).toEqual({ lastCheckMs: NOW, latestVersion: null, updateCommand: null })
  })
})

describe('readUpdateCache', () => {
  it('returns null when the file is absent (first run)', () => {
    expect(readUpdateCache()).toBeNull()
  })

  it.each(['not json at all', '{}', '{"lastCheckMs":"soon","latestVersion":null}', '[]', 'null'])(
    'returns null for corrupt content %o rather than throwing',
    (content) => {
      fs.mkdirSync(path.join(cacheHome, 'infra-kit'), { recursive: true })
      fs.writeFileSync(cacheFilePath(), content)

      expect(readUpdateCache()).toBeNull()
    },
  )
})

describe('isStale', () => {
  it('treats a missing cache as stale', () => {
    expect(isStale(null, NOW)).toBe(true)
  })

  it('is fresh inside the interval and stale at/after it', () => {
    const cache = { lastCheckMs: NOW, latestVersion: null, updateCommand: null }

    expect(isStale(cache, NOW + CHECK_INTERVAL_MS - 1)).toBe(false)
    expect(isStale(cache, NOW + CHECK_INTERVAL_MS)).toBe(true)
  })

  it('treats a future timestamp as stale rather than locking the user out until the clock catches up', () => {
    expect(isStale({ lastCheckMs: NOW + 1_000, latestVersion: null, updateCommand: null }, NOW)).toBe(true)
  })

  it('re-checks a transient outcome after the SHORT retry window, not the full 24h', () => {
    // The bug this fixes: a single `fetch-failed` burned the whole 24h window, so one blip disabled
    // auto-update for a day — exactly what a publisher hits pushing a release mid-window.
    const cache = { lastCheckMs: NOW, latestVersion: null, updateCommand: null, outcome: 'fetch-failed' }

    expect(isStale(cache, NOW + RETRY_INTERVAL_MS - 1)).toBe(false)
    expect(isStale(cache, NOW + RETRY_INTERVAL_MS)).toBe(true)
  })

  it('applies the short window to a transient outcome but the 24h window to a settled one at the same age', () => {
    // Two hours old: past the 1h retry, well inside the 24h throttle. A `fetch-failed` must re-check;
    // an `up-to-date` must not (that would re-fetch every couple of hours forever).
    const twoHoursOn = NOW + 2 * RETRY_INTERVAL_MS
    const base = { lastCheckMs: NOW, latestVersion: null, updateCommand: null }

    expect(isStale({ ...base, outcome: 'fetch-failed' }, twoHoursOn)).toBe(true)
    expect(isStale({ ...base, outcome: 'installing' }, twoHoursOn)).toBe(true)
    expect(isStale({ ...base, outcome: 'up-to-date' }, twoHoursOn)).toBe(false)
    expect(isStale({ ...base, outcome: 'installed' }, twoHoursOn)).toBe(false)
  })

  it('falls back to the 24h window for a cache with no outcome (pre-outcome format)', () => {
    // Back-compat: an on-disk cache written before `outcome` existed must not suddenly re-check hourly.
    const legacy = { lastCheckMs: NOW, latestVersion: null, updateCommand: null }

    expect(isStale(legacy, NOW + 2 * RETRY_INTERVAL_MS)).toBe(false)
    expect(isStale(legacy, NOW + CHECK_INTERVAL_MS)).toBe(true)
  })
})

// Locks the retryable/settled classification against drift. RETRYABLE_OUTCOMES has no compile-time tie to
// the `UpdateCheckOutcome` union (an import would cycle), so if a written outcome string is renamed on one
// side and not the other, nothing fails to compile — it just silently reverts to the wrong window, the
// exact class of bug this whole change fixes. Two hours on: past the 1h retry, inside the 24h throttle, so
// the two buckets give opposite verdicts and each string is pinned to its intended side.
describe('isStale outcome classification', () => {
  const staleAtTwoHours = (outcome: string): boolean => {
    return isStale({ lastCheckMs: NOW, latestVersion: null, updateCommand: null, outcome }, NOW + 2 * RETRY_INTERVAL_MS)
  }

  it.each(['fetch-failed', 'install-failed', 'parent-still-running', 'parent-unknown', 'installing'])(
    'treats the transient outcome %s as retryable within the hour',
    (outcome) => {
      expect(staleAtTwoHours(outcome)).toBe(true)
    },
  )

  it.each(['up-to-date', 'installed', 'cannot-self-spawn'])(
    'treats the settled outcome %s as fresh until the 24h window',
    (outcome) => {
      expect(staleAtTwoHours(outcome)).toBe(false)
    },
  )
})
