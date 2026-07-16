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

/**
 * Where the line between "survive" and "die" is drawn — and, far more importantly, where it is NOT.
 *
 * The barrier is load-bearing: an over-eager exit is a SILENT regression, in which sessions start dying on
 * faults they used to survive and nothing fails. So the discriminator is `isTerminalDead()` — a question
 * about our own stdio streams' IDENTITY — and never the shape of the error.
 */
describe('crashBarrier — terminal death is fatal, and nothing else is', () => {
  const capture = (): {
    handlers: Map<string, (error: unknown) => void>
    register: (event: 'uncaughtException' | 'unhandledRejection', handler: (error: unknown) => void) => void
  } => {
    const handlers = new Map<string, (error: unknown) => void>()

    return {
      handlers,
      register: (event, handler) => {
        handlers.set(event, handler)
      },
    }
  }

  it('files the fault and exits ONCE when stdio is dead, never printing and never surviving', () => {
    const { handlers, register } = capture()
    const filed: string[] = []
    const fatals: string[] = []
    const onFault = vi.fn()

    registerCrashBarrier({
      register,
      onFault,
      isTerminalDead: () => {
        return true
      },
      fileFault: (event, error) => {
        filed.push(formatFault(event, error, false))
      },
      onFatal: (reason) => {
        fatals.push(reason)
      },
    })

    handlers.get('uncaughtException')?.(new Error('write EIO'))

    expect(fatals).toHaveLength(1)
    // `onFault` is the PRINT path (runner.reportFault → renderer → the dead stream). Taking it here is the
    // loop: the report is written to what caused the fault, which faults again, forever.
    expect(onFault).not.toHaveBeenCalled()
    expect(filed).toHaveLength(1)
    expect(filed[0]).toContain('write EIO')
    // And the filed text must not claim a session that is on its way out was "kept alive".
    expect(filed[0]).not.toContain('kept alive')
  })

  /**
   * THE test that stops the code-sniff design.
   *
   * `EIO`/`EPIPE` are right there in the incident report, and keying on them is simpler than owning a stream's
   * `'error'` channel. But an in-process handler writing to a client socket that hung up throws `EPIPE` too —
   * so under a code-sniff, ONE user closing a browser tab mid-request kills every backend. Devs would see
   * "the dev server randomly dies under load", blame the watcher, and the barrier would be dead with no
   * failing test. This is that failing test.
   */
  it('survives a handler EPIPE while the terminal is alive — the false positive a code-sniff would create', () => {
    const { handlers, register } = capture()
    const faults: unknown[] = []
    const onFatal = vi.fn()
    const clientSocketEpipe: NodeJS.ErrnoException = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })

    registerCrashBarrier({
      register,
      onFault: (_event, error) => {
        faults.push(error)
      },
      isTerminalDead: () => {
        return false
      },
      onFatal,
    })

    handlers.get('uncaughtException')?.(clientSocketEpipe)
    handlers.get('unhandledRejection')?.(new Error('handler blew up'))

    // Survived both — reported, not exited. Exactly as before this change.
    expect(faults).toHaveLength(2)
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('defaults isTerminalDead to false, so library behaviour is unchanged and the exit path is opt-in', () => {
    const { handlers, register } = capture()
    const faults: unknown[] = []

    // No `isTerminalDead`, no `onFatal` — the shape every existing caller uses.
    registerCrashBarrier({
      register,
      onFault: (_event, error) => {
        faults.push(error)
      },
    })

    handlers.get('uncaughtException')?.(new Error('still just a bug'))

    expect(faults).toHaveLength(1)
  })
})

describe('formatFault — the fatal variant may not lie', () => {
  it('says "kept alive" on the survive path and NOT on the fatal one', () => {
    expect(formatFault('uncaughtException', new Error('x'))).toContain('kept alive')
    expect(formatFault('uncaughtException', new Error('x'), false)).not.toContain('kept alive')
    expect(formatFault('uncaughtException', new Error('x'), false)).toContain('stdio is unwritable')
  })
})
