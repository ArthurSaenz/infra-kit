import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { acquireStdin, releaseStdin, stdinReaderCount } from '../stdin-ref'

/**
 * The counter exists because `ref()`/`unref()` on a tty `ReadStream` is a sticky flag,
 * not a counter: the FIRST of two nested readers to finish would otherwise unref a handle
 * the outer one is still reading from, and the outer prompt would die with exit 13. These
 * tests pin the 0->1 / 1->0 edges, because those edges are the whole mechanism.
 */
const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')

/** A stdin faithful in the one respect that matters here: it can be ref'd and unref'd. */
const fakeStdin = () => {
  const stream = new PassThrough()
  const ref = vi.fn()
  const unref = vi.fn()

  Object.defineProperty(stream, 'ref', { value: ref, configurable: true })
  Object.defineProperty(stream, 'unref', { value: unref, configurable: true })
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true })

  return { ref, unref }
}

afterEach(() => {
  // Drain any reader a failing test left behind, so module state cannot leak forwards.
  while (stdinReaderCount() > 0) releaseStdin()

  if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
})

describe('stdin ref ownership', () => {
  it('refs on the first reader only, and unrefs on the last', () => {
    const { ref, unref } = fakeStdin()

    acquireStdin()
    expect(stdinReaderCount()).toBe(1)
    expect(ref).toHaveBeenCalledTimes(1)

    // The nested reader: the dev wizard runs ~5 prompts back to back.
    acquireStdin()
    expect(stdinReaderCount()).toBe(2)
    expect(ref).toHaveBeenCalledTimes(1)

    // THE CRUX — the inner reader finishing must NOT unref, or the outer prompt dies.
    releaseStdin()
    expect(stdinReaderCount()).toBe(1)
    expect(unref).not.toHaveBeenCalled()

    releaseStdin()
    expect(stdinReaderCount()).toBe(0)
    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('cannot be driven negative by an unmatched release', () => {
    const { ref, unref } = fakeStdin()

    releaseStdin()

    expect(stdinReaderCount()).toBe(0)
    expect(unref).not.toHaveBeenCalled()

    // The point of the clamp: a negative count would make `readers === 1` unreachable,
    // silently disarming the next acquire — the exact hang this module prevents.
    acquireStdin()

    expect(ref).toHaveBeenCalledTimes(1)
  })
})
