import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { createSafeStream } from '../safe-stderr'

/**
 * The guard that makes scrollback destruction impossible. Ink writes `ESC[2J ESC[3J ESC[H` whenever a
 * frame overflows the viewport; `ESC[3J` erases the scrollback buffer, which is where the session
 * shell keeps every command's output. These tests pin that byte out of the stream for good.
 */

const ERASE_SCROLLBACK = '[3J'
/** Exactly what `ansi-escapes` emits for `clearTerminal` on POSIX. */
const CLEAR_TERMINAL = `[2J${ERASE_SCROLLBACK}[H`

/** A fake stdout with the surface Ink actually touches (live dimensions + a resize emitter). */
const fakeStream = (): { stream: NodeJS.WriteStream; written: string[] } => {
  const written: string[] = []
  const emitter = new EventEmitter() as unknown as NodeJS.WriteStream & { rows: number }

  Object.assign(emitter, {
    columns: 80,
    rows: 24,
    isTTY: true,
    write: (chunk: string) => {
      written.push(chunk)

      return true
    },
  })

  return { stream: emitter, written }
}

describe('createSafeStream', () => {
  it("strips Ink's scrollback-erasing escape but keeps the rest of clearTerminal", () => {
    const { stream, written } = fakeStream()

    createSafeStream(stream).write(CLEAR_TERMINAL)

    expect(written[0]).not.toContain(ERASE_SCROLLBACK)
    expect(written[0]).toBe('[2J[H')
  })

  it('passes ordinary frames through untouched', () => {
    const { stream, written } = fakeStream()

    createSafeStream(stream).write('❯ audit\n')

    expect(written[0]).toBe('❯ audit\n')
  })

  it('strips every occurrence, not just the first', () => {
    const { stream, written } = fakeStream()

    createSafeStream(stream).write(`${CLEAR_TERMINAL}frame${CLEAR_TERMINAL}`)

    expect(written[0]).not.toContain(ERASE_SCROLLBACK)
  })

  it('reads dimensions live, so Ink sees a resize rather than a snapshot', () => {
    const { stream } = fakeStream()
    const safe = createSafeStream(stream)

    expect(safe.rows).toBe(24)
    expect(safe.isTTY).toBe(true)

    Object.assign(stream, { rows: 12 })

    expect(safe.rows).toBe(12)
  })

  it("relays Ink's resize subscription to the real stream", () => {
    const { stream } = fakeStream()
    const safe = createSafeStream(stream)
    const onResize = vi.fn()

    safe.on('resize', onResize)
    stream.emit('resize')

    expect(onResize).toHaveBeenCalledTimes(1)

    safe.off('resize', onResize)
    stream.emit('resize')

    expect(onResize).toHaveBeenCalledTimes(1)
  })
})
