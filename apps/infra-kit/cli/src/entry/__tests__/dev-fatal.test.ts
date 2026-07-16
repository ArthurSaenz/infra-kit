/**
 * The fatal path: what happens when the dev process's OWN stdio can no longer be written to.
 *
 * Two branches, and the `runner == null` one is a REGRESSION GUARD, not a corner case. Today an EIO during
 * boot correctly kills the process — the crash barrier is not installed until `run()` has returned. Step 1
 * arms a stdio `'error'` listener BEFORE `run()` (all of boot happens inside it: apps built, turbo and vite
 * spawned, Ink mounted — minutes during which a developer walks away and closes the window). A listener that
 * merely swallowed that error would make boot silently SURVIVE a dead terminal: strictly worse than today.
 * So boot reaps its descendant groups and exits, synchronously.
 *
 * `exit` and `forceReap` are seamed for the same reason `signal-shutdown` seams them: the real ones kill the
 * test runner and SIGKILL its children.
 */
import { describe, expect, it, vi } from 'vitest'

import { createFatalHandler } from 'src/entry/dev-server'

const seams = (): { exits: number[]; reaps: number[]; exit: (code: number) => void; forceReap: () => void } => {
  const exits: number[] = []
  const reaps: number[] = []

  return {
    exits,
    reaps,
    exit: (code) => {
      exits.push(code)
    },
    forceReap: () => {
      reaps.push(1)
    },
  }
}

describe('createFatalHandler', () => {
  it('boot (runner == null): reaps the descendant groups and exits — it must not swallow the error', () => {
    const { exits, reaps, exit, forceReap } = seams()
    const onFatal = createFatalHandler({
      getRunner: () => {
        return null
      },
      exit,
      forceReap,
    })

    onFatal('stdio unwritable: stdout EIO')

    expect(reaps).toHaveLength(1)
    expect(exits).toEqual([1])
  })

  it('runs the bounded teardown when the runner exists, filing the reason (never printing it)', async () => {
    const { exits, reaps, exit, forceReap } = seams()
    const filed: string[] = []
    let resolveTeardown = (): void => {}
    const runner = {
      shutdown: () => {
        return new Promise<void>((resolve) => {
          resolveTeardown = resolve
        })
      },
      fileFault: (detail: string) => {
        filed.push(detail)
      },
    }
    const onFatal = createFatalHandler({
      getRunner: () => {
        return runner
      },
      exit,
      forceReap,
    })

    onFatal('stdio unwritable: stdout ENOSPC')

    // The report names the ERRNO and is FILED, not printed: printing onto a dead stream is what produced the
    // fault. And on a file-backed stdout the terminal is fine — `ENOSPC` is a full disk, so "the terminal is
    // gone" would be a lie in the exact scenario this exists to fix.
    expect(filed.join('')).toContain('ENOSPC')
    expect(exits).toEqual([])

    resolveTeardown()
    await vi.waitFor(() => {
      expect(exits).toEqual([1])
    })
    // The graceful path owns its own reap (inside `shutdown()`); no force-quit was needed.
    expect(reaps).toHaveLength(0)
  })

  it('force-quits a wedged teardown on the deadline rather than spinning forever', () => {
    const { exits, reaps, exit, forceReap } = seams()
    let fireDeadline = (): void => {}
    const onFatal = createFatalHandler({
      getRunner: () => {
        return {
          shutdown: () => {
            return new Promise<void>(() => {})
          },
          fileFault: () => {},
        }
      },
      exit,
      forceReap,
      setTimer: (handler) => {
        fireDeadline = handler

        return (): void => {}
      },
    })

    onFatal('stdio unwritable: stdout EIO')
    expect(exits).toEqual([])

    fireDeadline()

    expect(reaps).toHaveLength(1)
    expect(exits).toEqual([1])
  })

  it('a REJECTING teardown raises zero unhandledRejection events — `.finally()` returns a DERIVED promise', async () => {
    // `shutdown()` attaches its `.catch` to the memoized `this.teardown`. `.finally()` hands back a NEW promise
    // with its own rejection state, so that handler does not cover it. `doShutdown()` can reject (`watcher.close`,
    // `turboWatch.kill`, `uiDev.kill` are unguarded), and this is the one path where an `unhandledRejection` feeds
    // straight back into the crash barrier that called us — with the terminal already dead, i.e. into `onFatal`.
    // Without the trailing `.catch` in `createFatalHandler` this test fails.
    const { exits, exit, forceReap } = seams()
    const teardown = Promise.reject(new Error('turbo would not die'))

    teardown.catch(() => {}) // stand in for `shutdown()`'s own same-tick handler on the memoized promise

    const onFatal = createFatalHandler({
      getRunner: () => {
        return {
          shutdown: () => {
            return teardown
          },
          fileFault: () => {},
        }
      },
      exit,
      forceReap,
    })

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }

    process.on('unhandledRejection', onUnhandled)

    try {
      onFatal('stdio unwritable: stdout EIO')

      // Let the rejection propagate through `.finally()` and, if unhandled, reach the process channel.
      await new Promise((resolve) => {
        return setTimeout(resolve, 0)
      })

      expect(unhandled).toEqual([])
      // And the process still exits — a rejecting teardown must not strand the session.
      expect(exits).toEqual([1])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('is once-only: terminal death arrives through several channels, and the reap must not run twice', () => {
    const { exits, reaps, exit, forceReap } = seams()
    const onFatal = createFatalHandler({
      getRunner: () => {
        return null
      },
      exit,
      forceReap,
    })

    onFatal('stdio unwritable: stdout EIO')
    onFatal('uncaughtException while stdio is unwritable')
    onFatal('stdio unwritable: stderr EIO')

    expect(reaps).toHaveLength(1)
    expect(exits).toEqual([1])
  })
})
