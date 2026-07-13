import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LOCK_STALE_MS, acquireUpdateLock } from '../lock'

/**
 * Staleness is judged against the lock file's REAL mtime, so the injected clock has to sit on the same
 * timeline. A frozen fake epoch would read as "decades before the file was written" and never reap.
 */
let NOW = 0

let dir = ''
let lockPath = ''

beforeEach(() => {
  NOW = Date.now()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-lock-'))
  lockPath = path.join(dir, 'nested', 'update-check.lock')
})

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true })
})

describe('acquireUpdateLock', () => {
  it('grants the lock and creates the containing directory', () => {
    const release = acquireUpdateLock({ lockPath, nowMs: NOW })

    expect(release).not.toBeNull()
    expect(fs.existsSync(lockPath)).toBe(true)

    release?.()
  })

  it('lets exactly ONE of many concurrent workers through', () => {
    // The whole point: five shells starting at once must not run five `npm install -g`.
    const releases = Array.from({ length: 5 }, () => {
      return acquireUpdateLock({ lockPath, nowMs: NOW })
    })

    expect(releases.filter(Boolean)).toHaveLength(1)

    releases.find(Boolean)?.()
  })

  it('frees the lock on release, so the next worker may run', () => {
    const first = acquireUpdateLock({ lockPath, nowMs: NOW })

    expect(first).not.toBeNull()
    first?.()

    expect(fs.existsSync(lockPath)).toBe(false)

    const second = acquireUpdateLock({ lockPath, nowMs: NOW })

    expect(second).not.toBeNull()
    second?.()
  })

  it('refuses while a fresh lock is held', () => {
    const held = acquireUpdateLock({ lockPath, nowMs: NOW })

    expect(acquireUpdateLock({ lockPath, nowMs: NOW })).toBeNull()

    held?.()
  })

  it('reaps a stale lock left by a killed worker', () => {
    const abandoned = acquireUpdateLock({ lockPath, nowMs: NOW })

    expect(abandoned).not.toBeNull()

    // Simulate the owner being SIGKILLed: the file survives, nothing releases it.
    // Staleness compares the injected clock against the file's REAL mtime, and the file is written a
    // few ms after `NOW` was captured (more under parallel load). The margin past the window must
    // therefore dwarf scheduling jitter — a tight `+1ms` flakes when that write is delayed.
    const later = NOW + LOCK_STALE_MS + 60_000
    const reclaimed = acquireUpdateLock({ lockPath, nowMs: later })

    expect(reclaimed).not.toBeNull()
    reclaimed?.()
  })

  it('does NOT reap a lock that is still inside the staleness window', () => {
    // A worker waiting out a long `infra-kit dev` parent legitimately holds the lock for minutes.
    const held = acquireUpdateLock({ lockPath, nowMs: NOW })

    expect(acquireUpdateLock({ lockPath, nowMs: NOW + LOCK_STALE_MS - 1 })).toBeNull()

    held?.()
  })

  it('releasing twice is harmless', () => {
    const release = acquireUpdateLock({ lockPath, nowMs: NOW })

    release?.()

    expect(() => {
      return release?.()
    }).not.toThrow()
  })

  it('returns null rather than throwing when the lock dir cannot be created', () => {
    const blocker = path.join(dir, 'blocker')

    fs.writeFileSync(blocker, 'not a directory')

    expect(acquireUpdateLock({ lockPath: path.join(blocker, 'x.lock'), nowMs: NOW })).toBeNull()
  })
})
