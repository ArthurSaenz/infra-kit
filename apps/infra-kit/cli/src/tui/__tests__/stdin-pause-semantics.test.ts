import process from 'node:process'
import { describe, expect, it } from 'vitest'

/**
 * The node semantics that `renderToStderr`'s `process.stdin.pause()` (tui/boot.tsx) depends on.
 *
 * WHAT THIS FENCES, AND WHAT IT DOES NOT — this file pins the RUNTIME CONTRACT: that `pause()` on
 * `process.stdin` still reaches libuv, and that it does so only when the stream is not already
 * explicitly paused. It would stay green if somebody deleted the `pause()` call from boot.tsx. The
 * consequence — that the parent stops stealing the child's tty bytes — is fenced by
 * `stdin-pause-pty.test.ts`, which needs a real tty and therefore only runs on darwin. This file is
 * the half that CI can see.
 *
 * WHY NOT MOUNT REAL INK HERE — measured: under vitest `process.stdin.isTTY` is `undefined`, and Ink
 * gates its whole input path on it (`ink/build/components/App.js:121`, and `attachReadableListener`
 * is reached only at :228, past the `if (!isRawModeSupported) throw` at :209-211). So Ink never
 * attaches its `readable` listener, `readableFlowing` stays `null`, `pause()` always emits, and the
 * test passes with OR WITHOUT the fix. A component using `useInput` makes it worse: Ink throws at
 * :210 and `renderToStderr` swallows it (boot.tsx), so the assertion would be green while Ink never
 * armed input at all. Driving the Ink-SHAPED teardown directly on the real `process.stdin` is what
 * keeps the object real.
 *
 * WHY THE NEGATIVE CASES ARE NOT PADDING — they are the half that makes this falsifiable. A test that
 * only asserts "the event fires" would also pass on a stream where it ALWAYS fires, which is exactly
 * the trap above. The set pins the CONDITION, not just the outcome.
 *
 * Verified against node v26 and ink 7.1.0.
 */

/** The Ink teardown shape that matters, minus Ink: a `readable` reader detaching. See App.js:126. */
const detachReadableReader = (): void => {
  const onReadable = (): void => {
    // Never invoked — attaching is the point, since it is what drives `readableFlowing` to `false`.
  }

  process.stdin.on('readable', onReadable)
  process.stdin.removeListener('readable', onReadable)
}

/** Count `'pause'` events across `run`, restoring the listener set afterwards. */
const countPauseEvents = async (run: () => void | Promise<void>): Promise<number> => {
  let events = 0
  const onPause = (): void => {
    events += 1
  }

  process.stdin.on('pause', onPause)

  try {
    await run()
  } finally {
    process.stdin.removeListener('pause', onPause)
  }

  return events
}

describe("the runtime contract behind renderToStderr's stdin.pause()", () => {
  /**
   * The guard on every other assertion here. `vitest.config.ts` pins `pool: 'forks'` so this stays a
   * main-thread `process.stdin`; under `pool: 'threads'` it would be a worker's, with ZERO bootstrap
   * listeners, and every test below would pass vacuously. Fail loudly and legibly instead.
   */
  it("process.stdin still carries node's bootstrap pause listener", () => {
    expect(process.stdin.listeners('pause')).toHaveLength(1)
  })

  /**
   * The production shape. Ink's unmount is driven by an I/O callback — a keypress arrives on stdin,
   * `useInput` runs, `exit()` unmounts and resolves `waitUntilExit()` — so the `await` in
   * `renderToStderr` resumes from a MACROTASK, and node drains the nextTick queue (carrying
   * `updateReadableListening`, which clears flowing to `null`) before that microtask runs.
   */
  it('emits pause when the await resumes from an I/O callback, as boot.tsx does', async () => {
    const events = await countPauseEvents(async () => {
      await new Promise<void>((resolveOuter) => {
        setImmediate(async () => {
          const inkExit = new Promise<void>((resolve) => {
            detachReadableReader()
            // Ink resolves in the same tick it detaches (ink.js:580 <- :300 <- App.js:126).
            resolve()
          })

          await inkExit

          expect(process.stdin.readableFlowing).not.toBe(false)
          process.stdin.pause()
          resolveOuter()
        })
      })
    })

    expect(events).toBe(1)
  })

  it('emits NOTHING when called synchronously — the fix would silently disarm', async () => {
    const events = await countPauseEvents(() => {
      detachReadableReader()

      // No await: `updateReadableListening` has not run, so flowing is still `false` and
      // `Readable.prototype.pause()` returns without emitting. No event, no readStop, no protection.
      expect(process.stdin.readableFlowing).toBe(false)
      process.stdin.pause()
    })

    expect(events).toBe(0)
  })

  /**
   * The limit of the guarantee, pinned so nobody over-reads the case above. Awaiting is not by itself
   * sufficient: if the resolve happens while a microtask drain is ALREADY in progress, the continuation
   * runs before the nextTick queue and flowing is still `false`. Ink is safe because its teardown
   * originates in I/O, not because an `await` appears in the source. If `renderToStderr` is ever
   * restructured so its exit promise settles from inside an existing microtask chain, this is the
   * behaviour it would get — a silent no-op.
   */
  it('an await is NOT sufficient on its own — resolving inside a microtask drain still disarms', async () => {
    const events = await countPauseEvents(async () => {
      // Already inside a microtask drain before the teardown happens.
      await Promise.resolve()

      const inkExit = new Promise<void>((resolve) => {
        detachReadableReader()
        resolve()
      })

      await inkExit

      expect(process.stdin.readableFlowing).toBe(false)
      process.stdin.pause()
    })

    expect(events).toBe(0)
  })
})
