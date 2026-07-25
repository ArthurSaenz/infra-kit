import { describe, expect, it } from 'vitest'

import { installSessionSignals } from '../run-session'
import type { SessionSignalDeps } from '../run-session'

/**
 * The session shell's signal policy. The child is spawned WITHOUT `detached`, so it shares the parent's
 * process group and the tty delivers every signal to BOTH — the parent's only job is to decide what it
 * does with its own copy. These assertions pin that policy; the terminal-level behaviour (a real Ctrl-C,
 * a real Ctrl-Z) is PTY territory and is verified separately.
 */
const harness = () => {
  const handlers = new Map<NodeJS.Signals, () => void>()
  const exits: number[] = []
  const raised: NodeJS.Signals[] = []
  // Ordered against `exits`: a reset AFTER the exit would never run, so both the count and the
  // sequence matter.
  const events: string[] = []
  let childRunning = false
  // A hand-cranked clock: the pnpm-relay exemption is defined by ELAPSED TIME, so the difference between
  // "the relay of the Ctrl-C just pressed" and "a deliberate kill later on" is only expressible here.
  let clock = 0

  const deps: SessionSignalDeps = {
    register: (signal, handler) => {
      handlers.set(signal, handler)
    },
    unregister: (signal) => {
      handlers.delete(signal)
    },
    exit: (code) => {
      exits.push(code)
      events.push(`exit:${code}`)
    },
    raise: (signal) => {
      raised.push(signal)
    },
    resetTerminal: () => {
      events.push('reset')
    },
    now: () => {
      return clock
    },
  }

  const signals = installSessionSignals(() => {
    return childRunning
  }, deps)

  return {
    exits,
    raised,
    events,
    signals,
    handlers,
    setChildRunning: (running: boolean) => {
      childRunning = running
    },
    advance: (ms: number) => {
      clock += ms
    },
    /** Deliver a signal to the installed handler (throws if the session never claimed it). */
    fire: (signal: NodeJS.Signals) => {
      const handler = handlers.get(signal)

      if (!handler) throw new Error(`no handler installed for ${signal}`)

      handler()
    },
  }
}

describe('session signals — while a child runs', () => {
  it('swallows SIGINT so Ctrl-C stops only the child and the loop survives to render the footer', () => {
    const t = harness()

    t.setChildRunning(true)
    t.fire('SIGINT')

    expect(t.exits).toEqual([])
  })

  // Under `pnpm exec infra-kit`, pnpm RELAYS a SIGTERM after the tty's SIGINT. That relay is an artifact
  // of the Ctrl-C the user aimed at the CHILD — honouring it would end the session on every cancel, so a
  // SIGTERM that FOLLOWS a SIGINT for the same child is swallowed.
  it('swallows the SIGTERM pnpm relays after a Ctrl-C (the session must survive a cancel)', () => {
    const t = harness()

    t.setChildRunning(true)
    t.signals.childStarted()
    t.fire('SIGINT')
    t.fire('SIGTERM')

    expect(t.exits).toEqual([])
    expect(t.signals.quitRequested()).toBe(false)
  })

  // …but a SIGTERM with NO preceding Ctrl-C is a genuine external `kill`. Dropping it outright (as the
  // first cut did) would make the session unkillable short of SIGKILL for as long as a child ran — and
  // `dev` runs for hours.
  it('defers a bare external SIGTERM: finishes the child, then quits', () => {
    const t = harness()

    t.setChildRunning(true)
    t.signals.childStarted()
    t.fire('SIGTERM')

    // Not an immediate exit — the child must finish and its transcript entry must commit first.
    expect(t.exits).toEqual([])
    // …but the loop is told to stop rather than re-render the palette over the kill.
    expect(t.signals.quitRequested()).toBe(true)
  })

  // The relay exemption is scoped to ONE child: a Ctrl-C during an earlier command must not license
  // swallowing a real `kill` during the next one.
  it('does not carry the Ctrl-C exemption across children', () => {
    const t = harness()

    t.setChildRunning(true)
    t.signals.childStarted()
    t.fire('SIGINT')

    // Next command starts: the per-child signal history resets.
    t.signals.childStarted()
    t.fire('SIGTERM')

    expect(t.signals.quitRequested()).toBe(true)
  })

  // The old code IGNORED SIGTSTP unconditionally: the tty stopped the child, the parent kept awaiting an
  // exit that could never come, and the terminal wedged with no prompt and no way back.
  it('stops ITSELF on SIGTSTP so the job suspends as a unit (Ctrl-Z no longer wedges the terminal)', () => {
    const t = harness()

    t.setChildRunning(true)
    t.fire('SIGTSTP')

    expect(t.raised).toEqual(['SIGSTOP'])
    expect(t.exits).toEqual([])
  })

  // The terminal is gone: staying alive would loop the palette onto a dead tty, drawing into a closed fd.
  it('never swallows SIGHUP — it exits even mid-child', () => {
    const t = harness()

    t.setChildRunning(true)
    t.fire('SIGHUP')

    expect(t.exits).toEqual([129])
  })
})

describe('session signals — between iterations (the palette is up)', () => {
  it('sIGINT ends the session cleanly, restoring the terminal BEFORE it exits', () => {
    const t = harness()

    t.setChildRunning(false)
    t.fire('SIGINT')

    expect(t.exits).toEqual([0])
    // Ordering is the assertion. This exit skips Ink's teardown, so if the reset does not precede it
    // the shell returns to a hidden cursor, a stranded frame, and a tty still in raw mode.
    expect(t.events).toEqual(['reset', 'exit:0'])
  })

  it('sIGTERM ends the session cleanly, restoring the terminal BEFORE it exits', () => {
    const t = harness()

    t.setChildRunning(false)
    t.fire('SIGTERM')

    expect(t.exits).toEqual([0])
    expect(t.events).toEqual(['reset', 'exit:0'])
  })

  it('sIGTSTP is ignored — suspending mid-palette would strand a half-drawn Ink frame', () => {
    const t = harness()

    t.setChildRunning(false)
    t.fire('SIGTSTP')

    expect(t.raised).toEqual([])
    expect(t.exits).toEqual([])
  })

  it('sIGHUP still exits', () => {
    const t = harness()

    t.setChildRunning(false)
    t.fire('SIGHUP')

    expect(t.exits).toEqual([129])
  })
})

/**
 * The relay exemption used to be a boolean, set on the first Ctrl-C and cleared only by the NEXT child.
 * So a command that stopped responding took the session's escape routes with it: every later SIGTERM
 * read as pnpm's relay, and `kill` was dead until that child was — SIGKILL the only way out.
 *
 * It is now a TIME WINDOW. A counter was the first attempt and was also wrong: it licensed one swallow
 * per Ctrl-C, but only a relay ever spends a licence, so running from the direct bin (no relay at all)
 * left unspent licences behind and still swallowed real kills — the same bug, narrowed to N.
 */
describe('session signals — the pnpm relay exemption is a window, not a latch', () => {
  // The three structural mutations (drop the condition, drop the reset, never record) leave the VALUE
  // free to drift — 100ms or 10s would pass them all. The boundary rows below pin it, and pin `<=`
  // against `<`. At 30s there is no keypress the SIGTERM could be a relay of: it is a deliberate kill.
  it.each([
    { gapMs: 5, quits: false, what: 'swallows the relay that lands immediately behind a Ctrl-C' },
    { gapMs: 1_000, quits: false, what: 'swallows a relay landing exactly on the window boundary' },
    { gapMs: 1_001, quits: true, what: 'honours a kill one millisecond past the boundary' },
    { gapMs: 30_000, quits: true, what: 'honours a kill that arrives well after the Ctrl-C it cannot belong to' },
  ])('$what (SIGTERM +$gapMs ms)', ({ gapMs, quits }) => {
    const t = harness()

    t.setChildRunning(true)
    t.signals.childStarted()

    t.fire('SIGINT')
    t.advance(gapMs)
    t.fire('SIGTERM')

    expect(t.signals.quitRequested()).toBe(quits)
  })

  it('keeps swallowing relays through a sustained mash, because each Ctrl-C reopens the window', () => {
    const t = harness()

    t.setChildRunning(true)
    t.signals.childStarted()

    // A user leaning on Ctrl-C for ten seconds: every keypress is paired with its own relay, and none
    // of them is a request to end the SESSION.
    for (let i = 0; i < 10; i += 1) {
      t.fire('SIGINT')
      t.advance(20)
      t.fire('SIGTERM')
      t.advance(980)
    }

    expect(t.signals.quitRequested()).toBe(false)
  })

  it('does not let a Ctrl-C from a PREVIOUS child license a relay for this one', () => {
    const t = harness()

    t.setChildRunning(true)
    t.signals.childStarted()
    t.fire('SIGINT')

    // Next command starts inside the window: without the per-child reset, its first SIGTERM would be
    // mistaken for a relay of the last command's keypress.
    t.signals.childStarted()
    t.fire('SIGTERM')

    expect(t.signals.quitRequested()).toBe(true)
  })
})

describe('session signals — lifecycle', () => {
  it('claims exactly the four signals it has a policy for', () => {
    const t = harness()

    expect([...t.handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGTSTP'])
  })

  it('dispose removes every handler (a leaked handler would outlive the session)', () => {
    const t = harness()

    t.signals.dispose()

    expect([...t.handlers.keys()]).toEqual([])
  })

  it('starts with no quit pending', () => {
    expect(harness().signals.quitRequested()).toBe(false)
  })
})
