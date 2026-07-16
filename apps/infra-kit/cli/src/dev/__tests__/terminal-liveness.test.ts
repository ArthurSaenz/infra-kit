/**
 * The `'error'` channel is the ONLY interceptable point of a failed stdio write, and this pins every
 * property the rest of the fix leans on.
 *
 * Nothing here installs a real `process.on('uncaughtException')` — that would swallow the runner's own
 * faults (`crash-barrier.ts:26`). The listener under test is attached to INJECTED streams instead, which is
 * exactly how it is attached in production: to specific stream OBJECTS, never to a global.
 */
import { EventEmitter } from 'node:events'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installTerminalLiveness, isTerminalDead } from 'src/dev/terminal-liveness'
import type { TerminalLiveness } from 'src/dev/terminal-liveness'

/**
 * A stdio stream that fails the way Node really fails: `write()` returns, and the error arrives on a LATER
 * TICK as an `'error'` event.
 *
 * This asynchrony is the whole reason the obvious fixes are non-fixes — a `try/catch` around the writer
 * catches nothing, and a synchronous re-entrancy latch sees an empty stack. It also keeps `destroyed=false`
 * and `writable=true` after the failure, exactly as Node's `dummyDestroy`-carrying stdio streams do, so a
 * fix keyed on those flags would silently never fire.
 */
class FakeStdio extends EventEmitter {
  readonly chunks: string[] = []
  /** Node's stdio streams `_undestroy()` themselves, so these stay LYING after the failure. */
  destroyed = false
  writable = true
  isTTY = true

  constructor(private readonly code: string) {
    super()
  }

  write(chunk: unknown): boolean {
    this.chunks.push(String(chunk))
    queueMicrotask(() => {
      const error: NodeJS.ErrnoException = Object.assign(new Error(`write ${this.code}`), { code: this.code })

      this.emit('error', error)
    })

    return true
  }
}

const asStream = (fake: FakeStdio): NodeJS.WriteStream => {
  return fake as unknown as NodeJS.WriteStream
}

/** Let every queued microtask (and the ticks they queue) run. */
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => {
    return setImmediate(resolve)
  })
}

const installed: TerminalLiveness[] = []

const install = (deps: Parameters<typeof installTerminalLiveness>[0]): TerminalLiveness => {
  const liveness = installTerminalLiveness(deps)

  installed.push(liveness)

  return liveness
}

afterEach(() => {
  // `uninstall` clears the module-scoped latch; without this a leaked `dead` would gate every raw write for
  // the rest of the worker.
  for (const liveness of installed.splice(0)) {
    liveness.uninstall()
  }
  vi.restoreAllMocks()
  expect(isTerminalDead()).toBe(false)
})

describe('installTerminalLiveness', () => {
  it('latches on the ASYNC error event a failed stdio write really produces, with zero uncaught faults', async () => {
    const stdout = new FakeStdio('EIO')
    const deaths: string[] = []
    const liveness = install({
      streams: [asStream(stdout)],
      onDeath: (stream, error) => {
        deaths.push(`${stream} ${error.code}`)
      },
    })

    expect(liveness.isDead()).toBe(false)

    // 100 writes, exactly as the storm did — the fault must be observed ONCE, not once per write.
    Array.from({ length: 100 }, () => {
      return stdout.write('a frame nobody will ever see\n')
    })

    await settle()

    expect(liveness.isDead()).toBe(true)
    expect(deaths).toEqual(['stdout EIO'])
  })

  it('sets the latch BEFORE onDeath runs — teardown repaints the terminal on its very first line', async () => {
    // `onDeath` → `onFatal` → `runner.shutdown()`, whose first act is `renderer.dispose()` →
    // `rerenderPersistent()`: a write to the stream that just died. Latch second and teardown begins by
    // re-arming the thing it is tearing down.
    const stdout = new FakeStdio('EIO')
    let deadWhenNotified: boolean | null = null

    install({
      streams: [asStream(stdout)],
      onDeath: () => {
        deadWhenNotified = isTerminalDead()
      },
    })

    stdout.write('x')
    await settle()

    expect(deadWhenNotified).toBe(true)
  })

  it('names the ERRNO, never a story: a file-backed stdout on a full disk reports ENOSPC', async () => {
    // The scenario this fix is FOR is a disk-fill. With stdout redirected to a file, `process.stdout` is a
    // SyncWriteStream and a failed writeSync takes the same async 'error' path — so `nohup ik dev > out.log`
    // on a full disk latches too. Exiting there is defensible; calling it "the terminal is gone" is a lie,
    // filed into the one log a post-mortem will read.
    const stdout = new FakeStdio('ENOSPC')
    const reasons: string[] = []

    install({
      streams: [asStream(stdout)],
      onDeath: (stream, error) => {
        reasons.push(`stdio unwritable: ${stream} ${error.code}`)
      },
    })

    stdout.write('x')
    await settle()

    expect(reasons).toEqual(['stdio unwritable: stdout ENOSPC'])
    expect(reasons[0]).not.toContain('terminal')
  })

  it('does NOT latch on the two transient errnos (EAGAIN, EINTR) — they mean "still alive"', async () => {
    for (const code of ['EAGAIN', 'EINTR']) {
      const stdout = new FakeStdio(code)
      const deaths: string[] = []
      const liveness = install({
        streams: [asStream(stdout)],
        onDeath: () => {
          deaths.push(code)
        },
      })

      stdout.write('x')
      await settle()

      expect(liveness.isDead()).toBe(false)
      expect(deaths).toEqual([])
      liveness.uninstall()
    }
  })

  it('reports whichever of the two streams died, so a dead stderr is not blamed on stdout', async () => {
    const stdout = new FakeStdio('EIO')
    const stderr = new FakeStdio('EPIPE')
    const deaths: string[] = []

    install({
      streams: [asStream(stdout), asStream(stderr)],
      onDeath: (stream, error) => {
        deaths.push(`${stream} ${error.code}`)
      },
    })

    stderr.write('x')
    await settle()

    expect(deaths).toEqual(['stderr EPIPE'])
  })

  /**
   * The anti-simplification pin. `destroyed` / `writable` are the two properties a future reader will reach
   * for, and both are probe-verified DEAD discriminators: Node's stdio streams carry a `dummyDestroy` that
   * `_undestroy()`s them, so they still read `false` / `true` after the write failed. A liveness check keyed
   * on either would compile, review cleanly, and never fire.
   */
  it('does not key on destroyed/writable — they still lie after the stream has failed', async () => {
    const stdout = new FakeStdio('EIO')
    const liveness = install({ streams: [asStream(stdout)] })

    stdout.write('x')
    await settle()

    expect(liveness.isDead()).toBe(true)
    // Both still claim the stream is perfectly healthy. That is the point.
    expect(stdout.destroyed).toBe(false)
    expect(stdout.writable).toBe(true)
  })

  it('a stray non-stdio error cannot reach the latch: the listener is bound to the stream OBJECTS', async () => {
    // The false positive the whole design exists to prevent. A request handler writing to a client socket
    // that hung up produces an EPIPE too — under an error-CODE sniff, one user closing a browser tab
    // mid-request would kill the entire dev session. Stream identity is the proof it cannot.
    const stdout = new FakeStdio('EIO')
    const handlerSocket = new FakeStdio('EPIPE')
    const liveness = install({ streams: [asStream(stdout)] })

    handlerSocket.on('error', () => {
      // The handler's own (hypothetical) error handling — nothing to do with our stdio.
    })
    handlerSocket.write('a response nobody is listening for')
    await settle()

    expect(liveness.isDead()).toBe(false)
  })

  it('uninstall detaches the listener and clears the latch', async () => {
    const stdout = new FakeStdio('EIO')
    const liveness = installTerminalLiveness({ streams: [asStream(stdout)] })

    stdout.write('x')
    await settle()
    expect(liveness.isDead()).toBe(true)

    liveness.uninstall()

    expect(liveness.isDead()).toBe(false)
    expect(isTerminalDead()).toBe(false)
    expect(stdout.listenerCount('error')).toBe(0)
  })

  it('defaults to the real stdio pair', () => {
    const before = process.stdout.listenerCount('error')

    install({})

    expect(process.stdout.listenerCount('error')).toBe(before + 1)
  })
})
