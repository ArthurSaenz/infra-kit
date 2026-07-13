import { describe, expect, it } from 'vitest'

import { classifyOutcome } from '../outcome'

describe('classifyOutcome', () => {
  it('report present + exit 0 => ok', () => {
    expect(classifyOutcome(0, null, true)).toBe('ok')
  })

  it('report present + exit 1 => findings', () => {
    expect(classifyOutcome(1, null, true)).toBe('findings')
  })

  it('report present + SIGINT => ok (teardown after the report was written)', () => {
    expect(classifyOutcome(null, 'SIGINT', true)).toBe('ok')
  })

  it('report absent + exit 1 => failed', () => {
    expect(classifyOutcome(1, null, false)).toBe('failed')
  })

  it('report absent + exit 0 => cancelled', () => {
    expect(classifyOutcome(0, null, false)).toBe('cancelled')
  })

  it('report absent + SIGINT => cancelled', () => {
    expect(classifyOutcome(null, 'SIGINT', false)).toBe('cancelled')
  })
})

/**
 * A long-running child (`dev`) writes no report and handles its OWN termination signal, exiting
 * `128 + signo` rather than dying by the signal. So it reports exit 130 with a NULL signal — which on
 * the default path is indistinguishable from a crash. Without the flag, every normal Ctrl-C out of the
 * dev server would be stamped `✗ failed`.
 */
describe('classifyOutcome — long-running commands exit 128+signo by design', () => {
  it('exit 130 (SIGINT) => cancelled, not failed', () => {
    expect(classifyOutcome(130, null, false, true)).toBe('cancelled')
    // Same code, ordinary command: still a failure. The flag must not widen the default path.
    expect(classifyOutcome(130, null, false)).toBe('failed')
  })

  it('exit 143 (SIGTERM) => cancelled', () => {
    expect(classifyOutcome(143, null, false, true)).toBe('cancelled')
  })

  it('a genuine boot crash still fails', () => {
    // e.g. a port already bound: dev exits 1 without ever having been signalled.
    expect(classifyOutcome(1, null, false, true)).toBe('failed')
  })

  it('a SIGKILL / OOM death still fails (not a user cancel)', () => {
    // 137 = 128 + SIGKILL. A `> 128` range check would wrongly call this a clean stop.
    expect(classifyOutcome(137, null, false, true)).toBe('failed')
    // 139 = 128 + SIGSEGV — a crash, not a stop.
    expect(classifyOutcome(139, null, false, true)).toBe('failed')
  })

  it('a clean exit 0 is still a cancel (Esc out of the dev wizard: no server ever started)', () => {
    expect(classifyOutcome(0, null, false, true)).toBe('cancelled')
  })
})
