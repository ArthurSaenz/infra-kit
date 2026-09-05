/**
 * @fileoverview
 *
 * The regression test for the 455 GB incident — and the only one that tells the real fix apart from the
 * non-fix.
 *
 * The loop: the terminal dies → a write fails → the error surfaces a tick later as an `uncaughtException` →
 * the crash barrier deliberately survives it and reports it → the report is written to the same dead stream
 * → back to the start, at 50k–127k faults/sec, until the disk is full.
 *
 * It is driven through the REAL components — the real `DevServerRunner.reportFault`, the real `DevLogSink`
 * (into a temp dir), the real `registerCrashBarrier`, the real `installTerminalLiveness` — against a fake
 * stdio stream that fails the way Node really fails: asynchronously.
 *
 * ## The one thing that is modelled, and why it is honest
 *
 * No test may install a real `process.on('uncaughtException')` — it would swallow the runner's own faults
 * (`crash-barrier.ts:26`). In production the edge from "a stream emitted `'error'` with nobody listening" to
 * "the crash barrier's handler runs" is Node's own machinery, and it is EventEmitter's documented rule: an
 * `'error'` event with no listener THROWS, and that throw escapes to `uncaughtException`. {@link FakeStdio}
 * implements exactly that rule and nothing more — `onUnhandled` is called only when
 * `listenerCount('error') === 0`. It is not a model of the LOOP (that would be circular); it is a model of
 * one documented delivery rule, and the loop is then a consequence the test observes rather than stages.
 *
 * The control case below proves the harness is faithful: with the liveness listener absent — i.e. against
 * the code as it shipped — the same setup runs away and blows a hard fault budget.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatFault, registerCrashBarrier } from 'src/dev/crash-barrier'
import { DevServerRunner } from 'src/dev/dev-server'
import { DevLogSink } from 'src/dev/log-sink'
import { installTerminalLiveness } from 'src/dev/terminal-liveness'
import type { TerminalLiveness } from 'src/dev/terminal-liveness'
import { PersistentInkDevUi } from 'src/tui/dev-ui/persistent-ink-dev-ui'

import { workingProxy } from './fixtures.js'

/** Hard budget, NOT a wall-clock timeout: against the unfixed code the loop never terminates on its own. */
const FAULT_BUDGET = 200

type FaultEvent = 'uncaughtException' | 'unhandledRejection'

/**
 * A stdio stream that fails like the real one: `write()` returns `true`, and the `EIO` arrives on a LATER
 * TICK as an `'error'` event. `destroyed`/`writable` keep lying afterwards, exactly as Node's `_undestroy`ing
 * stdio streams do.
 */
class FakeStdio extends EventEmitter {
  destroyed = false
  writable = true
  isTTY = true
  columns = 80
  rows = 24
  writes = 0

  constructor(
    private readonly code: string,
    /** Node's rule, and ONLY Node's rule: an `'error'` with no listener throws → `uncaughtException`. */
    private readonly onUnhandled: (error: unknown) => void,
  ) {
    super()
  }

  write(): boolean {
    this.writes += 1
    queueMicrotask(() => {
      const error: NodeJS.ErrnoException = Object.assign(new Error(`write ${this.code}`), { code: this.code })

      if (this.listenerCount('error') === 0) {
        this.onUnhandled(error)

        return
      }
      this.emit('error', error)
    })

    return true
  }
}

interface Harness {
  runner: DevServerRunner
  sink: DevLogSink
  stdout: FakeStdio
  liveness: TerminalLiveness | null
  /** Every `onFault` — the PRINT path, and the loop's edge. */
  faults: number
  fatals: string[]
  /** True once the harness stopped feeding the barrier because the fault budget was exhausted. */
  budgetBlown: () => boolean
  fire: (error: unknown) => void
  logBytes: () => number
  logText: () => string
}

/** Runner privates poked directly: `start()` would need a whole fixture monorepo, and none of it is on trial. */
interface RunnerPrivates {
  turboWatch: { kill: () => Promise<void> } | null
  uiDev: { kill: () => Promise<void> } | null
  watcher: { close: () => Promise<void> } | null
  appServers: { app: { name: string }; server: { close: () => Promise<void> } }[]
}

const cleanups: Array<() => void> = []

const makeHarness = (options: { withLiveness: boolean }): Harness => {
  const sink = new DevLogSink(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fault-loop-')), 'run'))
  const barrier = new Map<FaultEvent, (error: unknown) => void>()
  const state = { faults: 0, blown: false }
  const fatals: string[] = []

  const stdout = new FakeStdio('EIO', (error) => {
    // Node would raise this as an `uncaughtException`. Bounded, or the unfixed code never lets the test end.
    if (state.faults >= FAULT_BUDGET) {
      state.blown = true

      return
    }
    barrier.get('uncaughtException')?.(error)
  })

  // The REAL renderer the incident ran through, with the terminal swapped for the fake. After
  // `renderer.dispose()` (teardown's first act) `persistent` is false, so `log` falls through to the embedded
  // `DevRenderer` → `deps.write` → `stdout.write` — the exact call graph in the incident's stack.
  const renderer = new PersistentInkDevUi({
    appendLog: (text) => {
      sink.write('runner', text)
    },
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  const runner = new DevServerRunner(
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    renderer,
    undefined,
    workingProxy(),
    sink,
  )

  const liveness = options.withLiveness
    ? installTerminalLiveness({
        streams: [stdout as unknown as NodeJS.WriteStream],
        onDeath: (stream, error) => {
          fatals.push(`stdio unwritable: ${stream} ${error.code}`)
          runner.shutdown()
        },
      })
    : null

  registerCrashBarrier({
    register: (event, handler) => {
      barrier.set(event, handler)
    },
    onFault: (event, error) => {
      state.faults += 1
      runner.reportFault(formatFault(event, error))
    },
    isTerminalDead:
      liveness?.isDead ??
      ((): boolean => {
        return false
      }),
    fileFault: (event, error) => {
      runner.fileFault(formatFault(event, error, false))
    },
    onFatal: (reason) => {
      fatals.push(reason)
    },
  })

  cleanups.push(() => {
    liveness?.uninstall()
    sink.close()
  })

  const logPath = sink.pathFor('runner')

  return {
    runner,
    sink,
    stdout,
    liveness,
    get faults(): number {
      return state.faults
    },
    fatals,
    budgetBlown: () => {
      return state.blown
    },
    fire: (error) => {
      barrier.get('uncaughtException')?.(error)
    },
    logBytes: () => {
      return fs.existsSync(logPath) ? fs.statSync(logPath).size : 0
    },
    logText: () => {
      return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    },
  }
}

/** One macrotask turn — which first drains the whole microtask queue, and everything it queues. */
const tick = async (): Promise<void> => {
  await new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/** Several turns, so a fault that queues a write that queues a fault has every chance to come back round. */
const settle = async (): Promise<void> => {
  await Array.from({ length: 5 }).reduce(async (chain) => {
    await chain
    await tick()
  }, Promise.resolve())
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  vi.restoreAllMocks()
})

describe('the fault loop (the 455 GB incident)', () => {
  /**
   * THE CONTROL. This is the code as it shipped: no `'error'` listener on stdio, so the failed write becomes
   * an `uncaughtException`, the barrier survives it, `reportFault` writes the report to the same dead stream,
   * and round it goes. It does not converge — it exhausts the budget. Delete `installTerminalLiveness` and
   * the test below turns into this one.
   */
  it('without the liveness listener, one fault runs away, blowing the fault budget and growing the log', async () => {
    const h = makeHarness({ withLiveness: false })

    h.fire(new Error('the write that started it'))
    await settle()

    expect(h.budgetBlown()).toBe(true)
    expect(h.faults).toBeGreaterThanOrEqual(FAULT_BUDGET)
    // And every one of those faults is bytes on the disk. This is the 455 GB, in miniature.
    expect(h.logBytes()).toBeGreaterThan(10_000)
  })

  it('with the liveness listener, the loop cannot start — one fault, one fatal, a bounded log', async () => {
    const h = makeHarness({ withLiveness: true })

    h.fire(new Error('a handler blew up and the terminal is gone'))
    await settle()

    // The `'error'` event now HAS a listener, so it is no longer an `uncaughtException`: the edge that closed
    // the loop is gone. Not "fewer faults" — no second fault at all.
    expect(h.faults).toBe(1)
    expect(h.budgetBlown()).toBe(false)
    expect(h.liveness?.isDead()).toBe(true)
    expect(h.fatals).toEqual(['stdio unwritable: stdout EIO'])
    expect(h.logBytes()).toBeLessThan(100_000)
  })

  it('teardown does not re-arm the stream it is tearing down, and never re-enters the barrier', async () => {
    // `onDeath` → `shutdown()` → `renderer.dispose()` → a repaint, i.e. a write to the dead stream, on
    // teardown's very FIRST line. The latch is set before `onDeath` runs, so those writes are dropped and the
    // fault never comes back round.
    const h = makeHarness({ withLiveness: true })

    h.fire(new Error('boom'))
    await settle()
    await settle()

    expect(h.faults).toBe(1)
    expect(h.fatals).toHaveLength(1)
  })

  /**
   * Step 3b — the 2× amplifier nobody had noticed. `reportFault` filed every fault into `runner.log` TWICE:
   * once directly, and again via `renderer.log` → the renderer's file tee. A literal doubling of the 185 GB,
   * sitting at the centre of four defensive layers.
   */
  it('files a fault exactly ONCE, not twice (reportFault used to tee a second copy)', async () => {
    const h = makeHarness({ withLiveness: true })

    h.fire(new Error('UNIQUE-FAULT-MARKER-9f2a'))
    await settle()

    // Counted on the report HEADER, one per `formatFault` — not on the error message, which formatFault
    // legitimately prints twice inside a single report (once bare, once as the stack's first line).
    const copies = h.logText().split('⚠️  uncaughtException:').length - 1

    expect(copies).toBe(1)
    expect(h.logText()).toContain('UNIQUE-FAULT-MARKER-9f2a')
  })
})

describe('devServerRunner.shutdown — idempotent (L0)', () => {
  const wire = (runner: DevServerRunner): { kills: string[] } => {
    const kills: string[] = []
    const privates = runner as unknown as RunnerPrivates

    privates.turboWatch = {
      kill: async () => {
        kills.push('turboWatch.kill')
      },
    }
    privates.uiDev = {
      kill: async () => {
        kills.push('uiDev.kill')
      },
    }
    privates.appServers = [
      {
        app: { name: 'alpha' },
        server: {
          close: async () => {
            kills.push('server.close')
          },
        },
      },
    ]

    return { kills }
  }

  it('reaps each child exactly once when two callers shut down concurrently', async () => {
    // L1 and L2 wire a SECOND caller: terminal death is one event seen through two channels (the kernel's
    // SIGHUP and the stdio `'error'` listener), and both fire, in either order. Without the memo this would
    // SIGTERM→SIGKILL a child group that is already mid-reap — the one way this fix could strand children
    // worse than the bug it repairs.
    const h = makeHarness({ withLiveness: true })
    const { kills } = wire(h.runner)

    const first = h.runner.shutdown()
    const second = h.runner.shutdown()

    expect(second).toBe(first)

    await Promise.all([first, second])

    expect(kills).toEqual(['turboWatch.kill', 'uiDev.kill', 'server.close'])
  })

  it('a REJECTING teardown raises zero unhandledRejection events, even fire-and-forget', async () => {
    // The trap inside the fix. `shutdown()` can reject (`watcher.close`, `turboWatch.kill`, `uiDev.kill` are
    // unguarded), and the fatal path calls it fire-and-forget while a deadline races it. Memoize without
    // attaching the `.catch` IN THE ASSIGNING TICK and that rejection becomes an `unhandledRejection` → the
    // crash barrier → `onFault` → and, with the terminal already dead, straight back into `onFatal`: the very
    // loop being fixed, re-created inside its own fix.
    const h = makeHarness({ withLiveness: true })
    const privates = h.runner as unknown as RunnerPrivates

    privates.watcher = {
      close: () => {
        return Promise.reject(new Error('watcher would not close'))
      },
    }

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }

    process.on('unhandledRejection', onUnhandled)

    try {
      // Exactly the fatal path: nobody awaits this.
      h.runner.shutdown()

      // And a second caller who DOES await still sees the real rejection — the handler disarms the process
      // channel, it does not swallow the error.
      await expect(h.runner.shutdown()).rejects.toThrow('watcher would not close')

      await settle()

      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('exposes the teardown stage it is in, so a deadline can name the step that wedged', async () => {
    const h = makeHarness({ withLiveness: true })
    const privates = h.runner as unknown as RunnerPrivates
    let stageDuringKill = ''

    privates.turboWatch = {
      kill: async () => {
        stageDuringKill = h.runner.shutdownStage
      },
    }

    expect(h.runner.shutdownStage).toBe('idle')

    await h.runner.shutdown()

    expect(stageDuringKill).toBe('turboWatch.kill')
    expect(h.runner.shutdownStage).toBe('done')
  })
})
