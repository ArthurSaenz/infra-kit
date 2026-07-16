import select from '@inquirer/select'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import { mcpMode } from 'src/lib/mcp-mode'

import { withEscape } from '../escapable-context'

/**
 * These tests drive a REAL `@inquirer/select` and push REAL BYTES at it. That is the
 * whole point: an earlier revision of this feature was "covered" by a test that
 * emitted a fabricated `{ name: 'escape', sequence: '' }` key object at a fake
 * EventEmitter — it passed while Esc was 100% dead, because readline never emits that
 * shape. Nothing here may fabricate a key object or an EventEmitter.
 *
 * `process.stdin` is replaced with a PassThrough (`configurable: true`, verified) so
 * that the prompt and `withEscape` share one stream: `create-prompt.js` defaults
 * `input` to `process.stdin`, and `withEscape` listens on `process.stdin`. No PTY is
 * needed — `readline.createInterface({ terminal: true })` arms keypress parsing on any
 * stream, and inquirer never calls `setRawMode`.
 */

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')

const setStdin = (stream: PassThrough, isTTY: boolean) => {
  Object.defineProperty(stream, 'isTTY', { value: isTTY, configurable: true })
  // A real interactive `process.stdin` is a `tty.ReadStream`, which always carries
  // `ref`/`unref`; a bare PassThrough carries neither. `withEscape` owns the stdin ref
  // now (lib/prompts/stdin-ref), so a fake without them does not merely diverge from
  // reality — it throws. Spies rather than no-ops, so the ownership contract is
  // assertable rather than merely survivable.
  Object.defineProperty(stream, 'ref', { value: vi.fn(), configurable: true })
  Object.defineProperty(stream, 'unref', { value: vi.fn(), configurable: true })
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
}

/** The ref/unref spies {@link setStdin} installed on the current fake stdin. */
const stdinSpies = () => {
  return {
    ref: process.stdin.ref as unknown as ReturnType<typeof vi.fn>,
    unref: process.stdin.unref as unknown as ReturnType<typeof vi.fn>,
  }
}

afterEach(() => {
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
  mcpMode.enabled = false
})

/** Swallows the prompt's ANSI rendering so the suite's own output stays clean. */
const sink = () => {
  return new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
}

/**
 * A dead predicate does NOT reject — it leaves the prompt PENDING FOREVER, so a
 * regression would surface as a HUNG SUITE rather than a failing assertion. Every
 * await below is bounded, and the loser of the race names the predicate.
 */
const within = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined

  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `timed out after ${ms}ms waiting for ${what} — the raw-byte ESC predicate (chunk.length === 1 && chunk[0] === 0x1b) is probably dead`,
        ),
      )
    }, ms)
  })

  try {
    return await Promise.race([promise, bound])
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves once the prompt has rendered, i.e. readline is consuming the stream. */
const settle = async () => {
  await new Promise((resolve) => {
    return setTimeout(resolve, 50)
  })
}

const CHOICES = [
  { name: 'alpha', value: 'alpha' },
  { name: 'beta', value: 'beta' },
]

/** The prompt under test: a real `@inquirer/select`, wrapped. Reads `process.stdin`. */
const runSelect = () => {
  return withEscape(
    (context) => {
      return select({ message: 'pick one', choices: CHOICES }, context)
    },
    { output: sink() },
  )
}

/** The same prompt with NO withEscape — the control for the listener-leak test. */
const runBareSelect = (stdin: PassThrough) => {
  return select({ message: 'pick one', choices: CHOICES }, { input: stdin, output: sink() })
}

describe('withEscape — a real prompt, real bytes (THE GATE)', () => {
  it('aborts a live @inquirer/select when a lone 0x1b byte arrives', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)

    const pending = runSelect()

    await settle()
    stdin.write(Buffer.from([0x1b]))

    const error = await within(
      pending.then(
        (value) => {
          throw new Error(`expected the prompt to abort, but it resolved with ${String(value)}`)
        },
        (err: unknown) => {
          return err
        },
      ),
      2000,
      'the prompt to reject with AbortPromptError',
    )

    expect((error as Error).name).toBe('AbortPromptError')
    expect(isPromptCancellation(error)).toBe(true)
  })

  it('does NOT abort on a 3-byte arrow-down chunk — it navigates', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)

    const pending = runSelect()

    await settle()
    // Longer than one byte, so the predicate ignores it. Arrow-down then Enter must
    // select the SECOND choice — proving the raw listener does not steal bytes from
    // readline (Node `data` listeners broadcast).
    stdin.write(Buffer.from([0x1b, 0x5b, 0x42]))
    await settle()
    stdin.write(Buffer.from('\r'))

    expect(await within(pending, 2000, 'arrow-down + Enter to select the second choice')).toBe('beta')
  })

  it('does NOT abort on a 2-byte Alt-b chunk', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)

    const pending = runSelect()

    await settle()
    stdin.write(Buffer.from([0x1b, 0x62]))
    await settle()
    stdin.write(Buffer.from('\r'))

    expect(await within(pending, 2000, 'Alt-b to be ignored and Enter to select the first choice')).toBe('alpha')
  })

  it('leaks ZERO listeners of its own, measured against a bare-inquirer control', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)

    const enter = async (pending: Promise<string>) => {
      await settle()
      stdin.write(Buffer.from('\r'))
      await within(pending, 2000, 'the prompt to resolve')
    }

    // Two facts about inquirer, both MEASURED — record them so nobody "fixes" a leak
    // that does not exist:
    //   1. A bare prompt (no withEscape at all) leaves ONE `data` listener on the
    //      stream after it resolves. readline's `emitKeypressEvents` installs that
    //      consumer and never removes it. So an absolute `=== 0` assertion is
    //      unreachable, and a naive `before`-vs-`after` delta on a fresh stream just
    //      measures inquirer's residue rather than ours.
    //   2. It does NOT accumulate: across 5 sequential prompts on one stream it stays
    //      pinned at 1, because inquirer REPLACES its listener each time. The wizard's
    //      ~5-prompts-in-a-row case is therefore safe.
    // Hence the control below: whatever a bare prompt leaves behind is inquirer's
    // floor. Running the SAME prompt through withEscape must not exceed it — any
    // listener of ours that survived the `finally` would show up as control + 1.
    await enter(runBareSelect(stdin))
    const control = stdin.listenerCount('data')

    await enter(runSelect())

    expect(stdin.listenerCount('data')).toBe(control)
    expect(stdin.listenerCount('keypress')).toBe(0)
  })
})

/**
 * Measures the listener count from INSIDE a still-pending `run`, because `withEscape`
 * attaches only after invoking `run`. Counting after the fact would pass even if the
 * listener were never attached at all.
 */
const listenersDuringRun = async (): Promise<number> => {
  let observed = -1

  await withEscape(async () => {
    await new Promise((resolve) => {
      return setImmediate(resolve)
    })

    observed = process.stdin.listenerCount('data')

    return 'done'
  })

  return observed
}

describe('withEscape — the MCP/TTY guard', () => {
  it('attaches NOTHING when stdin is a TTY but the process is serving MCP', async () => {
    const stdin = new PassThrough()

    // The `stdio: 'inherit'` shape: a terminal-launched `infra-kit mcp` really does
    // have a TTY stdin. An isTTY-ONLY guard passes this precondition and attaches a
    // raw listener to the JSON-RPC stream — so it MUST fail this test. That is the
    // entire reason the test exists.
    setStdin(stdin, true)
    mcpMode.enabled = true

    expect(await listenersDuringRun()).toBe(stdin.listenerCount('data'))
  })

  it('attaches nothing when stdin is not a TTY and MCP is off', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, false)

    expect(await listenersDuringRun()).toBe(stdin.listenerCount('data'))
  })

  it('attaches the listener on a plain interactive TTY (proves the guard tests above are not vacuous)', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)

    expect(await listenersDuringRun()).toBe(stdin.listenerCount('data') + 1)
  })

  it('still passes an AbortSignal through to the prompt context when guarded off', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, false)

    const signal = await withEscape((context) => {
      return Promise.resolve(context.signal)
    })

    expect(signal).toBeInstanceOf(AbortSignal)
  })
})

/**
 * `withEscape` is the seam that keeps stdin alive for inquirer, which refs nothing itself.
 * Without this, a prompt opened after an Ink screen tore down reads a stdin Ink unref'd on
 * its way out, the loop drains mid-question and node exits 13 — see lib/prompts/stdin-ref.
 */
describe('withEscape — stdin ownership', () => {
  it("holds stdin ref'd for the duration of the prompt and gives it back after", async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)

    const { ref, unref } = stdinSpies()

    let refsDuringPrompt = 0
    let unrefsDuringPrompt = 0

    await withEscape(() => {
      refsDuringPrompt = ref.mock.calls.length
      unrefsDuringPrompt = unref.mock.calls.length

      return Promise.resolve('done')
    })

    // Ref'd BEFORE the prompt runs — reffing afterwards would be reffing a corpse.
    expect(refsDuringPrompt).toBe(1)
    expect(unrefsDuringPrompt).toBe(0)
    // ...and handed back on the way out, or the session shell could never exit.
    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('gives the ref back even when the prompt rejects', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)

    const { unref } = stdinSpies()

    await expect(
      withEscape(() => {
        return Promise.reject(new Error('prompt blew up'))
      }),
    ).rejects.toThrow('prompt blew up')

    // An Esc abort rejects too: a throwing path that kept the ref would hang the CLI.
    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('gives the ref back when the prompt throws SYNCHRONOUSLY', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)

    const { unref } = stdinSpies()

    // A throw on the way to BUILDING the promise, not a rejected one. `@inquirer/core` runs
    // synchronously up to readline construction, so this path is reachable. `withEscape` is
    // `async`, so it surfaces as a rejection either way — but the ref only comes back if the
    // `finally` encloses the `run()` call itself. Move `run()` above the `try` and this fails.
    await expect(
      withEscape(() => {
        throw new Error('threw before returning a promise')
      }),
    ).rejects.toThrow('threw before returning a promise')

    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('does not leak a reader across a nested withEscape', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)

    const { unref } = stdinSpies()

    let unrefsAfterInner = 0

    await withEscape(async () => {
      // The dev wizard runs ~5 prompts back to back. The inner one finishing must not unref
      // the handle the outer one is still reading from.
      await withEscape(() => {
        return Promise.resolve('inner')
      })

      unrefsAfterInner = unref.mock.calls.length

      return 'outer'
    })

    expect(unrefsAfterInner).toBe(0)
    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('takes no ref at all when stdin is not a TTY (nothing there to read)', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, false)

    const { ref } = stdinSpies()

    await withEscape(() => {
      return Promise.resolve('done')
    })

    // Acquiring below the early return would ref a handle nobody reads — a pure hang.
    expect(ref).not.toHaveBeenCalled()
  })
})
