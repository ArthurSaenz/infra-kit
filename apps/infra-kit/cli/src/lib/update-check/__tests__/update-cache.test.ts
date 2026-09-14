import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CACHE_FILE_NAME,
  CHECK_INTERVAL_MS,
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

describe('readUpdateCache — plugin field', () => {
  it('round-trips the optional plugin record and reads a cache written before it existed', () => {
    const withPlugin = {
      lastCheckMs: NOW,
      latestVersion: null,
      updateCommand: null,
      outcome: 'up-to-date',
      plugin: { outcome: 'updated' as const, checkedMs: NOW + 700 },
    }

    writeUpdateCache(withPlugin)
    expect(readUpdateCache()).toEqual(withPlugin)

    writeUpdateCache({ lastCheckMs: NOW, latestVersion: null, updateCommand: null, outcome: 'up-to-date' })
    expect(readUpdateCache()?.plugin).toBeUndefined()
  })

  it('round-trips the skipped-cli-stale outcome the worker stamps when it withholds the plugin step', () => {
    // The stamp lands beside the newer `latestVersion` that caused it: the one write says both.
    const withheld = {
      lastCheckMs: NOW,
      latestVersion: '0.8.0',
      updateCommand: ['brew', 'upgrade', 'infra-kit'],
      outcome: 'cannot-self-spawn',
      plugin: { outcome: 'skipped-cli-stale' as const, checkedMs: NOW + 700 },
    }

    writeUpdateCache(withheld)
    expect(readUpdateCache()).toEqual(withheld)
  })

  it.each(['"updated"', '{"outcome":"updated"}', '{"checkedMs":1}', '{"outcome":1,"checkedMs":1}'])(
    'rejects a malformed plugin record %s as corrupt',
    (plugin) => {
      fs.mkdirSync(path.join(cacheHome, 'infra-kit'), { recursive: true })
      fs.writeFileSync(
        cacheFilePath(),
        `{"lastCheckMs":1,"latestVersion":null,"updateCommand":null,"plugin":${plugin}}`,
      )

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

  // Pins the ONE window against a re-introduced outcome-aware branch. A shorter window for transient
  // outcomes is not a free "recover faster" win: anything below a full worker cycle (a
  // PARENT_WAIT_TIMEOUT_MS parent wait, then an install) re-checks while the first worker still holds
  // the single-flight lock, and the loser returns without writing — so the cache stays stale and every
  // command spawns a doomed worker until LOCK_STALE_MS reaps it. See CHECK_INTERVAL_MS.
  it.each([
    'fetch-failed',
    'install-failed',
    'parent-still-running',
    'parent-unknown',
    'installing',
    'up-to-date',
    'installed',
    'cannot-self-spawn',
  ])('gives the outcome %s the same window as every other outcome', (outcome) => {
    const cache = { lastCheckMs: NOW, latestVersion: null, updateCommand: null, outcome }

    expect(isStale(cache, NOW + CHECK_INTERVAL_MS - 1)).toBe(false)
    expect(isStale(cache, NOW + CHECK_INTERVAL_MS)).toBe(true)
  })

  it('gives a cache with no outcome the same window too (pre-outcome format)', () => {
    // Back-compat: an on-disk cache written before `outcome` existed reads as a normal throttled entry.
    const legacy = { lastCheckMs: NOW, latestVersion: null, updateCommand: null }

    expect(isStale(legacy, NOW + CHECK_INTERVAL_MS - 1)).toBe(false)
    expect(isStale(legacy, NOW + CHECK_INTERVAL_MS)).toBe(true)
  })
})
