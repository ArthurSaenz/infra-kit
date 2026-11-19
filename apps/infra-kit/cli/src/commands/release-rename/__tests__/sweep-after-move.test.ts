import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { waitAndSweepOldPath } from '../sweep-after-move'

let root: string
let oldPath: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-sweep-'))
  oldPath = path.join(root, 'release', 'v1.2.3')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const exists = async (target: string): Promise<boolean> => {
  return fs.access(target).then(
    () => {
      return true
    },
    () => {
      return false
    },
  )
}

const writeOmcState = async (): Promise<void> => {
  await fs.mkdir(path.join(oldPath, '.omc', 'state'), { recursive: true })
  await fs.writeFile(path.join(oldPath, '.omc', 'state', 'x'), '{}')
}

/** A clock that only moves when the code under test sleeps, plus a hook into each sleep call. */
const fakeTime = (onSleep: (call: number) => Promise<void>) => {
  let clock = 0
  let calls = 0

  return {
    now: () => {
      return clock
    },
    sleep: async (ms: number) => {
      calls += 1
      clock += ms
      await onSleep(calls)
    },
    calls: () => {
      return calls
    },
    elapsed: () => {
      return clock
    },
  }
}

describe('waitAndSweepOldPath', () => {
  it('sweeps a delayed writer and returns once the path stays absent for quietMs', async () => {
    let wrote = false

    const time = fakeTime(async (call) => {
      if (call === 3) {
        await writeOmcState()
        wrote = true
      }
    })

    await waitAndSweepOldPath({ oldPath, sleep: time.sleep, now: time.now })

    expect(wrote).toBe(true)
    expect(await exists(oldPath)).toBe(false)
    // Swept at t=1500, absent from t=2000, quiet for 3 000 ms.
    expect(time.elapsed()).toBe(5_000)
  })

  it('fails with "a writer is still active" when the leftover reappears on every tick past boundMs', async () => {
    const time = fakeTime(async () => {
      await writeOmcState()
    })

    await expect(waitAndSweepOldPath({ oldPath, sleep: time.sleep, now: time.now })).rejects.toThrow(
      `a writer is still active in ${oldPath}`,
    )
    expect(time.elapsed()).toBeGreaterThanOrEqual(10_000)
  })

  it('fails naming the path and a non-sweepable entry, deleting nothing', async () => {
    await fs.mkdir(oldPath, { recursive: true })
    await fs.writeFile(path.join(oldPath, 'notes.txt'), 'keep me')
    await fs.mkdir(path.join(oldPath, '.omc', 'state'), { recursive: true })

    const time = fakeTime(async () => {})

    const failure = waitAndSweepOldPath({ oldPath, sleep: time.sleep, now: time.now })

    await expect(failure).rejects.toThrow(oldPath)
    await expect(failure).rejects.toThrow('notes.txt')
    expect(await fs.readFile(path.join(oldPath, 'notes.txt'), 'utf8')).toBe('keep me')
    expect(await exists(path.join(oldPath, '.omc', 'state'))).toBe(true)
  })

  it('fails naming the path when the sweep itself cannot delete it, not as "a writer is still active"', async () => {
    await writeOmcState()

    const lockedParent = path.join(oldPath, '.omc', 'state')

    // No write bit on the parent: removing `x` fails EACCES while every readdir still succeeds.
    await fs.chmod(lockedParent, 0o500)

    try {
      const time = fakeTime(async () => {})
      const failure = waitAndSweepOldPath({ oldPath, sleep: time.sleep, now: time.now })

      await expect(failure).rejects.toThrow(`could not delete ${oldPath}`)
      await expect(failure).rejects.not.toThrow('a writer is still active')
      expect(await exists(path.join(lockedParent, 'x'))).toBe(true)
    } finally {
      await fs.chmod(lockedParent, 0o700)
    }
  })

  it('returns after quietMs when nothing ever appears', async () => {
    const time = fakeTime(async () => {})

    await waitAndSweepOldPath({ oldPath, sleep: time.sleep, now: time.now })

    expect(time.elapsed()).toBe(3_000)
  })
})
