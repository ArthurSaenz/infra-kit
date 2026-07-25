/**
 * `signal-shutdown`'s teardown deadline and `createFatalHandler`'s fatal deadline both exist to
 * force-exit a wedged `boundRunner.shutdown()` when nobody is watching — and a closed terminal can arm
 * BOTH of them for the exact same shutdown() call (SIGHUP fires first; `registerSignalShutdown`'s own
 * `onSignal` write is what produces the stdio `'error'` that routes into `onFatal` a tick later). Without a
 * shared owner each would count down its own 20s timer against the same wedge, and a hang would exit with
 * whichever code's timer happened to fire first instead of the honest one.
 *
 * These tests exercise {@link createSharedDeadlineTimer} in isolation, against a fake underlying timer —
 * the dedupe logic doesn't need a real process or a real `runDevServer` to prove out.
 */
import { describe, expect, it } from 'vitest'

import { createSharedDeadlineTimer } from 'src/entry/dev-server'

/** A fake `setTimer`: records every arm, and lets a test fire a specific arm's handler by hand. */
const fakeTimer = (): {
  arms: { handler: () => void; ms: number }[]
  setTimer: (handler: () => void, ms: number) => () => void
  cancels: number
} => {
  const arms: { handler: () => void; ms: number }[] = []
  let cancels = 0

  return {
    arms,
    get cancels(): number {
      return cancels
    },
    setTimer: (handler, ms) => {
      arms.push({ handler, ms })

      return (): void => {
        cancels += 1
      }
    },
  }
}

describe('createSharedDeadlineTimer', () => {
  it('arms the underlying timer on the first call', () => {
    const fake = fakeTimer()
    const shared = createSharedDeadlineTimer(fake.setTimer)

    shared(() => {}, 20_000)

    expect(fake.arms).toHaveLength(1)
    expect(fake.arms[0]?.ms).toBe(20_000)
  })

  it('does NOT arm a second underlying timer while the first is still pending — the whole point', () => {
    const fake = fakeTimer()
    const shared = createSharedDeadlineTimer(fake.setTimer)

    shared(() => {}, 20_000)
    shared(() => {}, 20_000)

    // Only ONE real timer exists — a second watchdog racing the same wedge gets no timer of its own.
    expect(fake.arms).toHaveLength(1)
  })

  it("a second caller's canceller is a no-op — it never armed anything to cancel", () => {
    const fake = fakeTimer()
    const shared = createSharedDeadlineTimer(fake.setTimer)

    shared(() => {}, 20_000)
    const cancelSecond = shared(() => {}, 20_000)

    cancelSecond()

    // The underlying timer from the FIRST call is untouched by the second call's cancel.
    expect(fake.cancels).toBe(0)
  })

  it('releases ownership on cancel, so a later, genuinely independent event can arm its own timer', () => {
    const fake = fakeTimer()
    const shared = createSharedDeadlineTimer(fake.setTimer)

    const cancelFirst = shared(() => {}, 20_000)

    cancelFirst()
    expect(fake.cancels).toBe(1)

    shared(() => {}, 20_000)

    expect(fake.arms).toHaveLength(2)
  })

  it('the owning timer still fires normally — the force-exit guarantee is unchanged', () => {
    const fake = fakeTimer()
    const shared = createSharedDeadlineTimer(fake.setTimer)
    const fired: string[] = []

    shared(() => {
      fired.push('signal-deadline')
    }, 20_000)

    fake.arms[0]?.handler()

    expect(fired).toEqual(['signal-deadline'])
  })

  it('two independent createSharedDeadlineTimer instances do not share state — only one instance backs both watchdogs', () => {
    const fakeA = fakeTimer()
    const fakeB = fakeTimer()
    const sharedA = createSharedDeadlineTimer(fakeA.setTimer)
    const sharedB = createSharedDeadlineTimer(fakeB.setTimer)

    sharedA(() => {}, 20_000)
    sharedB(() => {}, 20_000)

    expect(fakeA.arms).toHaveLength(1)
    expect(fakeB.arms).toHaveLength(1)
  })
})
