import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RestartScheduler } from '../restart-scheduler'

const DEBOUNCE_MS = 400

const harness = (): {
  scheduler: RestartScheduler
  runs: Array<[string, string[]]>
  errors: string[]
  stop: () => void
} => {
  const runs: Array<[string, string[]]> = []
  const errors: string[] = []
  let stopped = false

  const scheduler = new RestartScheduler({
    debounceMs: DEBOUNCE_MS,
    isStopped: () => {
      return stopped
    },
    onError: (key, error) => {
      errors.push(`${key}: ${String(error)}`)
    },
  })

  return {
    scheduler,
    runs,
    errors,
    stop: () => {
      stopped = true
    },
  }
}

const record = (runs: Array<[string, string[]]>, name: string) => {
  return async (changed: string[]): Promise<void> => {
    runs.push([name, changed])
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('restartScheduler', () => {
  it('collapses a burst on one key into one run that answers for every changed file', async () => {
    const { scheduler, runs } = harness()

    scheduler.schedule('shop', 'a.js', record(runs, 'shop'))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
    scheduler.schedule('shop', 'b.js', record(runs, 'shop'))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(runs).toEqual([['shop', ['a.js', 'b.js']]])
  })

  it('folds a pending per-key restart, and its files, into a restart of everything', async () => {
    const { scheduler, runs } = harness()

    scheduler.schedule('shop', 'shop.js', record(runs, 'shop'))
    scheduler.scheduleAll(['shop', 'blog'], 'lib.js', record(runs, 'all'))

    expect(scheduler.isAllPending()).toBe(true)

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(runs).toEqual([['all', ['lib.js', 'shop.js']]])
    expect(scheduler.isAllPending()).toBe(false)
  })

  it('runs nothing after clear, and nothing once stopped', async () => {
    const { scheduler, runs, stop } = harness()

    scheduler.schedule('shop', 'a.js', record(runs, 'shop'))
    scheduler.clear()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    scheduler.schedule('shop', 'b.js', record(runs, 'shop'))
    stop()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    scheduler.schedule('shop', 'c.js', record(runs, 'shop'))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(runs).toEqual([])
  })

  it('reports rejected work under its key instead of throwing', async () => {
    const { scheduler, errors } = harness()

    scheduler.debounce('shop', async () => {
      throw new Error('listen EADDRINUSE')
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(errors).toEqual(['shop: Error: listen EADDRINUSE'])
  })
})
