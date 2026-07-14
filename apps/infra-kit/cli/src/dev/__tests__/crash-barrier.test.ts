import { describe, expect, it, vi } from 'vitest'

import { formatFault, registerCrashBarrier } from '../crash-barrier.js'

describe('registerCrashBarrier', () => {
  it('wires both fault channels and reports without exiting', () => {
    const handlers = new Map<string, (error: unknown) => void>()
    const faults: Array<{ event: string; error: unknown }> = []
    const exit = vi.fn()
    const realExit = process.exit

    // Guard: prove the barrier never exits even if a handler somehow reached process.exit.
    process.exit = exit as unknown as typeof process.exit

    try {
      registerCrashBarrier({
        register: (event, handler) => {
          handlers.set(event, handler)
        },
        onFault: (event, error) => {
          faults.push({ event, error })
        },
      })

      expect([...handlers.keys()].sort()).toEqual(['uncaughtException', 'unhandledRejection'])

      const boom = new Error('handler blew up')

      handlers.get('uncaughtException')?.(boom)
      handlers.get('unhandledRejection')?.('a bare rejection')

      expect(faults).toEqual([
        { event: 'uncaughtException', error: boom },
        { event: 'unhandledRejection', error: 'a bare rejection' },
      ])
      expect(exit).not.toHaveBeenCalled()
    } finally {
      process.exit = realExit
    }
  })

  it('default reporter writes message and stack to stderr and never throws', () => {
    const handlers = new Map<string, (error: unknown) => void>()
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))

      return true
    })

    try {
      // Default onFault (no override) exercised through the injected register seam.
      registerCrashBarrier({
        register: (event, handler) => {
          handlers.set(event, handler)
        },
      })

      expect(() => {
        handlers.get('uncaughtException')?.(new Error('kaboom'))
      }).not.toThrow()

      const written = writes.join('')

      expect(written).toContain('uncaughtException')
      expect(written).toContain('kaboom')
      expect(written).toContain('kept alive')
    } finally {
      spy.mockRestore()
    }
  })
})

/**
 * The fault channel must survive the terminal being taken over.
 *
 * `infra-kit dev` now owns `process.stderr` for the life of a TTY session — every line is routed into a
 * per-service log file and nothing prints. The crash barrier's DEFAULT reporter is a plain
 * `process.stderr.write`, so once suppression is on, an `uncaughtException` the barrier deliberately
 * survives would be quietly FILED: the panel would go on showing `● ok` and `⚠ 0` over a session that
 * has just faulted, and the user would have no reason to open any log.
 *
 * That is why the dev entry replaces `onFault`. These pin the seam it depends on.
 */
describe('crashBarrier — the fault seam the dev entry replaces', () => {
  it('routes a fault to the injected onFault instead of stderr, so it can be filed AND printed', () => {
    const faults: string[] = []
    const handlers = new Map<string, (error: unknown) => void>()

    registerCrashBarrier({
      onFault: (event, error) => {
        faults.push(formatFault(event, error))
      },
      register: (event, handler) => {
        handlers.set(event, handler)
      },
    })

    handlers.get('uncaughtException')?.(new Error('handler blew up'))

    expect(faults).toHaveLength(1)
    expect(faults[0]).toContain('handler blew up')
    // The stack matters: a bare message is not enough to find the bug in a session that prints nothing.
    expect(faults[0]).toMatch(/at\s/)
    // And it says the session survived — otherwise the user assumes the process is gone and kills it.
    expect(faults[0]).toContain('kept alive')
  })

  it('formatFault carries a non-Error throw through rather than swallowing it', () => {
    expect(formatFault('unhandledRejection', 'a bare string rejection')).toContain('a bare string rejection')
  })
})
