import process from 'node:process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { registerRunCleanup, withRunCleanup } from '../run-cleanup'

/**
 * The guard exists because `finally` does not run when Node takes its default
 * action for SIGINT, and `gh-merge-dev` holds a scratch worktree across the
 * confirmation prompt. A leaked registration is not cosmetic: the next run's
 * `worktree add` fails with `is a missing but already registered worktree`, so
 * the command stays broken on that machine until someone knows to run
 * `git worktree prune`.
 *
 * The listener-count assertions matter as much as the cleanup ones. `ghMergeDev`
 * is ALSO the MCP tool handler inside a long-lived server, so a handler left
 * attached — or attached at all on that path — would fire on the host's own
 * shutdown and exit the server mid-session.
 */

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

/** A fake signal bus, so a test can raise SIGINT without killing the runner. */
const makeBus = () => {
  const handlers = new Map<NodeJS.Signals, () => void>()

  return {
    register: (signal: NodeJS.Signals, handler: () => void): void => {
      handlers.set(signal, handler)
    },
    unregister: (signal: NodeJS.Signals): void => {
      handlers.delete(signal)
    },
    raise: (signal: NodeJS.Signals): void => {
      handlers.get(signal)?.()
    },
    has: (signal: NodeJS.Signals): boolean => {
      return handlers.has(signal)
    },
    size: (): number => {
      return handlers.size
    },
  }
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => {
    return setImmediate(resolve)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('withRunCleanup', () => {
  it('releases registered resources and exits 130 on SIGINT', async () => {
    const bus = makeBus()
    const exit = vi.fn()
    const release = vi.fn().mockResolvedValue(undefined)

    await withRunCleanup(
      async () => {
        registerRunCleanup(release)
        bus.raise('SIGINT')
        await flush()
      },
      { register: bus.register, unregister: bus.unregister, exit },
    )

    expect(release).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('exits 143 on SIGTERM', async () => {
    const bus = makeBus()
    const exit = vi.fn()

    await withRunCleanup(
      async () => {
        registerRunCleanup(vi.fn().mockResolvedValue(undefined))
        bus.raise('SIGTERM')
        await flush()
      },
      { register: bus.register, unregister: bus.unregister, exit },
    )

    expect(exit).toHaveBeenCalledWith(143)
  })

  it('still exits when a cleanup throws — shutdown is not the place to fail', async () => {
    const bus = makeBus()
    const exit = vi.fn()

    await withRunCleanup(
      async () => {
        registerRunCleanup(vi.fn().mockRejectedValue(new Error('worktree busy')))
        bus.raise('SIGINT')
        await flush()
      },
      { register: bus.register, unregister: bus.unregister, exit },
    )

    expect(exit).toHaveBeenCalledWith(130)
  })

  it('detaches both handlers when the run finishes normally', async () => {
    const bus = makeBus()

    await withRunCleanup(
      async () => {
        expect(bus.size()).toBe(2)
        expect(bus.has('SIGINT')).toBe(true)
        expect(bus.has('SIGTERM')).toBe(true)
      },
      { register: bus.register, unregister: bus.unregister, exit: vi.fn() },
    )

    expect(bus.size()).toBe(0)
  })

  it('detaches both handlers when the run throws', async () => {
    const bus = makeBus()

    await expect(
      withRunCleanup(
        async () => {
          throw new Error('boom')
        },
        { register: bus.register, unregister: bus.unregister, exit: vi.fn() },
      ),
    ).rejects.toThrow('boom')

    expect(bus.size()).toBe(0)
  })

  it('adds exactly one real process listener per signal, and returns to baseline', async () => {
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    }

    await withRunCleanup(async () => {
      expect(process.listenerCount('SIGINT')).toBe(before.SIGINT + 1)
      expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM + 1)
    })

    // Left attached, these would fire on a later signal in a long-lived process.
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT)
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM)
  })

  it('returns the wrapped value untouched', async () => {
    await expect(
      withRunCleanup(async () => {
        return 'result'
      }),
    ).resolves.toBe('result')
  })
})
