import { describe, expect, it } from 'vitest'

import type { AtlasSnapshot } from '../../../lib/atlas-contract'
import { formatClock } from '../../../lib/format-clock'
import { makeSnapshot } from '../../../testing/snapshot-fixture'
import * as service from '../services'
import type { PollResponse, PollerState } from '../types'

type Answer = { status: 200; snapshot: AtlasSnapshot } | { status: 304 } | { status: 503 } | 'network-error'

/**
 * A hand-driven clock and fetch: each `step()` fires the one pending timer and waits for the poll it
 * started to settle, so the test reads as the schedule the page actually follows.
 */
const harness = (answers: Answer[]) => {
  const pending: Array<{ run: () => void; ms: number; id: number }> = []
  const requests: Array<Record<string, string>> = []
  const changes: PollerState[] = []
  let hidden = false
  let nextId = 0
  let onVisibility: () => void = () => {}

  const respond = (answer: Answer): PollResponse => {
    if (answer === 'network-error') throw new TypeError('Failed to fetch')

    return {
      status: answer.status,
      headers: {
        get: (name) => {
          return answer.status === 200 && name === 'ETag' ? `"${answer.snapshot.revision}"` : null
        },
      },
      json: async () => {
        return answer.status === 200 ? answer.snapshot : { runner: 'down' }
      },
    }
  }

  const poller = service.createPoller({
    fetch: async (url, init) => {
      expect(url).toBe(service.STATE_URL)
      requests.push(init.headers)

      return respond(answers.shift() ?? { status: 304 })
    },
    visibility: {
      isHidden: () => {
        return hidden
      },
      subscribe: (listener) => {
        onVisibility = listener

        return () => {}
      },
    },
    timers: {
      setTimeout: (run, ms) => {
        nextId += 1
        pending.push({ run, ms, id: nextId })

        return nextId
      },
      clearTimeout: (handle) => {
        const index = pending.findIndex((timer) => {
          return timer.id === handle
        })

        if (index >= 0) pending.splice(index, 1)
      },
    },
    now: () => {
      return new Date(2026, 10, 12, 9, 5, requests.length)
    },
    onChange: (state) => {
      changes.push(state)
    },
  })

  const settle = async (): Promise<void> => {
    // A macrotask turn drains every microtask the fake fetch chain queued.
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
  }

  return {
    poller,
    requests,
    changes,
    pending,
    settle,
    step: async (): Promise<number> => {
      const timer = pending.shift()

      if (timer === undefined) throw new Error('no timer pending')
      timer.run()
      await settle()

      return timer.ms
    },
    setHidden: async (value: boolean): Promise<void> => {
      hidden = value
      onVisibility()
      await settle()
    },
  }
}

describe('poller', () => {
  it('repaints on a new revision and sends the ETag back', async () => {
    const h = harness([
      { status: 200, snapshot: makeSnapshot() },
      { status: 200, snapshot: makeSnapshot({ revision: 'rev-2' }) },
    ])

    h.poller.start()
    await h.settle()
    await h.step()

    expect(
      h.changes.map((state) => {
        return state.snapshot?.revision
      }),
    ).toEqual(['rev-1', 'rev-2'])
    expect(h.requests).toEqual([{}, { 'If-None-Match': '"rev-1"' }])
  })

  it('does not repaint on 304', async () => {
    const h = harness([{ status: 200, snapshot: makeSnapshot() }, { status: 304 }, { status: 304 }])

    h.poller.start()
    await h.settle()
    await h.step()
    await h.step()

    expect(h.changes).toHaveLength(1)
    expect(
      h.pending.map((timer) => {
        return timer.ms
      }),
    ).toEqual([2000])
  })

  it('shows the disconnect banner only after two consecutive failures', async () => {
    const h = harness([{ status: 200, snapshot: makeSnapshot() }, { status: 503 }, 'network-error'])

    h.poller.start()
    await h.settle()
    await h.step()

    expect(h.changes.at(-1)?.status).toBe('live')

    await h.step()

    const last = h.changes.at(-1)

    expect(last?.status).toBe('disconnected')
    expect(last?.snapshot?.revision).toBe('rev-1')
    expect(formatClock(last!.lastUpdate!)).toBe('09:05:01')
  })

  it('backs off 2 → 4 → 8 → 10 s while disconnected and recovers on the next answer', async () => {
    const h = harness(
      [503, 503, 503, 503, 503, 503].map(() => {
        return { status: 503 } as const
      }),
    )

    h.poller.start()
    await h.settle()
    for (const expected of [2000, 2000, 4000, 8000, 10_000]) expect(await h.step()).toBe(expected)

    expect(
      h.pending.map((timer) => {
        return timer.ms
      }),
    ).toEqual([10_000])

    await h.step()

    expect(h.changes.at(-1)?.status).toBe('live')
    expect(
      h.pending.map((timer) => {
        return timer.ms
      }),
    ).toEqual([2000])
  })

  it('pauses while the tab is hidden and polls at once when it returns', async () => {
    const h = harness([{ status: 200, snapshot: makeSnapshot() }])

    h.poller.start()
    await h.settle()
    await h.setHidden(true)

    expect(h.pending).toEqual([])

    await h.setHidden(false)

    expect(h.requests).toHaveLength(2)
    expect(h.pending).toHaveLength(1)
  })

  it('does not poll at all when started in a hidden tab', async () => {
    const h = harness([])

    await h.setHidden(true)
    h.poller.start()
    await h.settle()

    expect(h.requests).toEqual([])
  })

  it('stops polling and flags the page when the runner speaks a newer contract', async () => {
    const h = harness([{ status: 200, snapshot: { ...makeSnapshot(), v: 2 } as unknown as AtlasSnapshot }])

    h.poller.start()
    await h.settle()

    expect(h.changes.at(-1)?.status).toBe('outdated')
    expect(h.pending).toEqual([])
  })

  it('keeps the healthy cadence below the disconnect threshold', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(service.delayAfter)).toEqual([2000, 2000, 2000, 4000, 8000, 10_000, 10_000])
  })
})
