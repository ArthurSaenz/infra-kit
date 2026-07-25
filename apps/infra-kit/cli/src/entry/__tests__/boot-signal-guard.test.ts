/**
 * The boot-window guard: what happens when SIGINT/SIGTERM lands BEFORE `run()` has returned a
 * runner. Nothing here spawns a process or delivers a real POSIX signal — `register`/`unregister`
 * capture the handlers so a test can fire them by hand, mirroring `signal-shutdown.test.ts`'s harness.
 */
import { describe, expect, it } from 'vitest'

import { installBootSignalGuard } from 'src/entry/dev-server'

/**
 * Fake signal bus standing in for `process.on`/`process.off`. Tracks handlers per signal (a `Set`,
 * not a single slot) so `remove()` can be asserted to drop exactly the ones this guard added.
 */
const fakeSignalBus = (): {
  fire: (signal: NodeJS.Signals) => void
  register: (signal: NodeJS.Signals, handler: () => void) => void
  unregister: (signal: NodeJS.Signals, handler: () => void) => void
  count: (signal: NodeJS.Signals) => number
} => {
  const handlers = new Map<NodeJS.Signals, Set<() => void>>()

  return {
    fire: (signal) => {
      for (const handler of handlers.get(signal) ?? []) handler()
    },
    register: (signal, handler) => {
      const set = handlers.get(signal) ?? new Set()

      set.add(handler)
      handlers.set(signal, set)
    },
    unregister: (signal, handler) => {
      handlers.get(signal)?.delete(handler)
    },
    count: (signal) => {
      return handlers.get(signal)?.size ?? 0
    },
  }
}

describe('installBootSignalGuard', () => {
  it('during the boot window (a slow, not-yet-settled run()), a SIGINT reaps the descendant groups and exits 130 — the conventional code, not the fatal path’s fixed one', () => {
    const exits: number[] = []
    const reaps: number[] = []
    const bus = fakeSignalBus()

    installBootSignalGuard({
      forceReap: () => {
        return reaps.push(1)
      },
      exit: (code) => {
        return exits.push(code)
      },
      register: bus.register,
      unregister: bus.unregister,
    })

    // Stand-in for `run()` still being in flight — a cold `turbo` build that hasn't resolved yet.
    const stillBooting = new Promise<void>(() => {})

    bus.fire('SIGINT')

    expect(reaps).toHaveLength(1)
    expect(exits).toEqual([130])
    // The pending "boot" is never awaited — the guard fires synchronously without it.
    expect(stillBooting).toBeInstanceOf(Promise)
  })

  it('reaps and exits 143 on SIGTERM during boot', () => {
    const exits: number[] = []
    const reaps: number[] = []
    const bus = fakeSignalBus()

    installBootSignalGuard({
      forceReap: () => {
        return reaps.push(1)
      },
      exit: (code) => {
        return exits.push(code)
      },
      register: bus.register,
      unregister: bus.unregister,
    })

    bus.fire('SIGTERM')

    expect(reaps).toHaveLength(1)
    expect(exits).toEqual([143])
  })

  it('claims only SIGINT and SIGTERM — SIGHUP stays unclaimed here; `registerSignalShutdown` owns it once handoff happens', () => {
    const bus = fakeSignalBus()

    installBootSignalGuard({ forceReap: () => {}, exit: () => {}, register: bus.register, unregister: bus.unregister })

    expect(bus.count('SIGINT')).toBe(1)
    expect(bus.count('SIGTERM')).toBe(1)
    expect(bus.count('SIGHUP')).toBe(0)
  })

  it('remove() detaches both listeners, so a signal after handoff no longer reaches this guard', () => {
    const exits: number[] = []
    const bus = fakeSignalBus()

    const guard = installBootSignalGuard({
      forceReap: () => {},
      exit: (code) => {
        return exits.push(code)
      },
      register: bus.register,
      unregister: bus.unregister,
    })

    guard.remove()
    bus.fire('SIGINT')
    bus.fire('SIGTERM')

    expect(exits).toEqual([])
    expect(bus.count('SIGINT')).toBe(0)
    expect(bus.count('SIGTERM')).toBe(0)
  })

  /**
   * The listener-count assertion the handoff itself relies on: `runDevServer` calls `remove()` in a
   * `finally` around `run()`, then (on success) `registerSignalShutdown` installs its own SIGINT/SIGTERM
   * handlers. If `remove()` didn't actually drop the real `process` listeners, every subsequent signal
   * would double-fire — this guard's reap-and-exit AND the graceful teardown, racing each other.
   */
  it('against the real process: adds exactly one SIGINT and one SIGTERM listener, and remove() drops exactly those back to baseline', () => {
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    }

    const guard = installBootSignalGuard({ forceReap: () => {}, exit: () => {} })

    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT + 1)
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM + 1)

    guard.remove()

    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT)
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM)
  })
})
