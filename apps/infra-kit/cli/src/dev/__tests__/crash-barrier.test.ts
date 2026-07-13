import { describe, expect, it, vi } from 'vitest'

import { registerCrashBarrier } from '../crash-barrier.js'

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
