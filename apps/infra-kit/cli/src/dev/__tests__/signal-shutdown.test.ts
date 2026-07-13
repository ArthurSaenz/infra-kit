/**
 * Exercises the shutdown state machine through its three seams. Nothing here spawns a process or
 * delivers a real POSIX signal: `register` captures the handlers so a test can fire them by hand,
 * and `exit` records codes instead of killing the vitest worker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { exitCodeForSignal, registerSignalShutdown } from 'src/dev/signal-shutdown'

/**
 * Capture handlers per signal + every exit code, standing in for `process.on` / `process.exit`.
 *
 * `forceReap` is seamed too, and that is not optional: the real one shells out to `ps` and SIGKILLs
 * every process group descended from the caller. Left unstubbed, the force-quit tests below would
 * aim that at the vitest worker's own children.
 */
const harness = (): {
  fire: (signal: NodeJS.Signals) => void
  exits: number[]
  reaps: number
  /** Which signals were actually claimed — lets a test assert the HANDLED_SIGNALS surface itself. */
  handlers: Map<NodeJS.Signals, () => void>
  seams: {
    exit: (code: number) => void
    register: (signal: NodeJS.Signals, handler: () => void) => void
    forceReap: () => void
  }
} => {
  const handlers = new Map<NodeJS.Signals, () => void>()
  const exits: number[] = []
  const state = { reaps: 0 }

  return {
    fire: (signal) => {
      const handler = handlers.get(signal)

      if (!handler) throw new Error(`no handler registered for ${signal}`)
      handler()
    },
    exits,
    handlers,
    get reaps(): number {
      return state.reaps
    },
    seams: {
      exit: (code) => {
        exits.push(code)
      },
      register: (signal, handler) => {
        handlers.set(signal, handler)
      },
      forceReap: () => {
        state.reaps += 1
      },
    },
  }
}

/** Collect stderr writes without letting them reach the test reporter. */
const spyStderr = (sink: string[]): ReturnType<typeof vi.spyOn> => {
  return vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown): boolean => {
    sink.push(String(chunk))

    return true
  }) as never)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('exitCodeForSignal', () => {
  it('maps a signal to the conventional 128 + signo', () => {
    expect(exitCodeForSignal('SIGINT')).toBe(130)
    expect(exitCodeForSignal('SIGTERM')).toBe(143)
  })

  it('falls back to SIGINT (130) for a signal the host table lacks', () => {
    // Cast: the point is a signal name outside the platform's `os.constants.signals`.
    expect(exitCodeForSignal('SIGNOTREAL' as NodeJS.Signals)).toBe(130)
  })
})

describe('registerSignalShutdown', () => {
  it('runs the teardown once on the first signal, then exits 130', async () => {
    const { fire, exits, seams } = harness()
    const onSignal = vi.fn().mockResolvedValue(undefined)

    registerSignalShutdown({ onSignal, ...seams })
    fire('SIGINT')

    await vi.waitFor(() => {
      expect(exits).toEqual([130])
    })
    expect(onSignal).toHaveBeenCalledTimes(1)
    expect(onSignal).toHaveBeenCalledWith('SIGINT')
  })

  it('exits 143 on SIGTERM — the code a supervisor reads on the non-TTY path', async () => {
    const { fire, exits, seams } = harness()

    registerSignalShutdown({ onSignal: vi.fn().mockResolvedValue(undefined), ...seams })
    fire('SIGTERM')

    await vi.waitFor(() => {
      expect(exits).toEqual([143])
    })
  })

  /**
   * SIGHUP — the terminal went away (window closed, ssh dropped). It MUST run the same teardown, because
   * of invariant 2: the tty delivers SIGHUP to the foreground process group, which this process is in,
   * but the turbo/vite children are NOT — they sit in their own detached groups. Take SIGHUP's default
   * kill instead of handling it and the teardown never runs, `killDescendantGroupsNow` never fires, and
   * the whole tree survives holding the dev ports; the next start then 502s.
   *
   * Closing the terminal is the most common way to walk away from a dev server, so this is the LIKELIEST
   * orphan path — and it is invisible without this test: dropping 'SIGHUP' from HANDLED_SIGNALS otherwise
   * passes the entire suite.
   */
  it('tears down and reaps on SIGHUP (a closed terminal must not orphan the detached child groups)', async () => {
    const { fire, exits, seams } = harness()
    const onSignal = vi.fn().mockResolvedValue(undefined)

    registerSignalShutdown({ onSignal, ...seams })
    fire('SIGHUP')

    await vi.waitFor(() => {
      // 128 + SIGHUP(1). Honest signal death, same contract as SIGINT/SIGTERM.
      expect(exits).toEqual([129])
    })
    // The teardown ran — this is the assertion that the reap is reached at all.
    expect(onSignal).toHaveBeenCalledTimes(1)
    expect(onSignal).toHaveBeenCalledWith('SIGHUP')
  })

  it('claims SIGHUP as a handled signal', () => {
    const { seams, handlers } = harness()

    registerSignalShutdown({ onSignal: vi.fn().mockResolvedValue(undefined), ...seams })

    expect([...handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM'])
  })

  it('force-quits on a second signal while the teardown is still in flight, without re-running it', () => {
    const stderr: string[] = []

    spyStderr(stderr)

    const { fire, exits, seams } = harness()
    // Never resolves: models a wedged teardown, the exact case the old `if (shuttingDown) return`
    // guard made inescapable without `kill -9`.
    const onSignal = vi.fn().mockReturnValue(new Promise<void>(() => {}))

    registerSignalShutdown({ onSignal, ...seams })
    fire('SIGINT')
    fire('SIGINT')

    // Synchronous: the escape must not wait on the wedged teardown promise.
    expect(exits).toEqual([130])
    expect(onSignal).toHaveBeenCalledTimes(1)
    expect(stderr.join('')).toContain('force-quitting')
  })

  it('reaps the descendant groups on the force-quit path, so a double Ctrl-C leaves no orphans', () => {
    spyStderr([])

    const h = harness()

    registerSignalShutdown({ onSignal: vi.fn().mockReturnValue(new Promise<void>(() => {})), ...h.seams })
    h.fire('SIGINT')
    expect(h.reaps).toBe(0) // the graceful path owns its own teardown

    h.fire('SIGINT')
    expect(h.reaps).toBe(1)
  })

  // The regression that orphaned a turbo tree on EVERY Ctrl-C: `pnpm exec` relays a SIGTERM of its
  // own after the TTY's SIGINT, so one keypress lands as two signals. The old "any second signal
  // force-quits" rule read that relay as an impatient user and abandoned the children mid-teardown.
  it('ignores a wrapper-relayed SIGTERM after SIGINT, letting the teardown finish', async () => {
    const stderr: string[] = []

    spyStderr(stderr)

    const h = harness()
    let resolveTeardown = (): void => {}
    const teardown = new Promise<void>((resolve) => {
      resolveTeardown = resolve
    })
    const onSignal = vi.fn().mockReturnValue(teardown)

    registerSignalShutdown({ onSignal, ...h.seams })

    h.fire('SIGINT') // the TTY, to the whole foreground process group
    h.fire('SIGTERM') // pnpm relaying — NOT a second keypress

    // The relay must not preempt anything: no exit, no force-reap, teardown still running.
    expect(h.exits).toEqual([])
    expect(h.reaps).toBe(0)
    expect(stderr.join('')).not.toContain('force-quitting')

    resolveTeardown()

    // And the teardown still owns the exit, reporting the signal that actually started it.
    await vi.waitFor(() => {
      expect(h.exits).toEqual([130])
    })
    expect(onSignal).toHaveBeenCalledTimes(1)
    expect(onSignal).toHaveBeenCalledWith('SIGINT')
  })

  it('still force-quits when a supervisor escalates SIGTERM → SIGTERM', () => {
    spyStderr([])

    const h = harness()

    registerSignalShutdown({ onSignal: vi.fn().mockReturnValue(new Promise<void>(() => {})), ...h.seams })
    h.fire('SIGTERM')
    h.fire('SIGTERM')

    expect(h.exits).toEqual([143])
    expect(h.reaps).toBe(1)
  })

  it('logs a rejected teardown (message + stack) and still exits 128 + signo, never 0', async () => {
    const stderr: string[] = []

    spyStderr(stderr)

    const { fire, exits, seams } = harness()
    const boom = new Error('turbo would not die')

    registerSignalShutdown({ onSignal: vi.fn().mockRejectedValue(boom), ...seams })
    fire('SIGINT')

    await vi.waitFor(() => {
      expect(exits).toEqual([130])
    })

    const written = stderr.join('')

    expect(written).toContain('turbo would not die')
    expect(written).toContain(boom.stack ?? 'no stack')
    expect(exits).not.toContain(0)
  })

  it('still exits when the teardown rejects AND stderr is a broken pipe', async () => {
    // Both failures at once: the rejection handler writes to a stderr that throws (EPIPE). If the exit
    // were a trailing statement after the catch rather than a `finally`, the throw would skip it and the
    // process would survive its own SIGINT.
    vi.spyOn(process.stderr, 'write').mockImplementation((() => {
      throw new Error('EPIPE')
    }) as never)

    const { fire, exits, seams } = harness()

    registerSignalShutdown({ onSignal: vi.fn().mockRejectedValue(new Error('teardown blew up')), ...seams })
    fire('SIGINT')

    await vi.waitFor(() => {
      expect(exits).toEqual([130])
    })
  })
})
