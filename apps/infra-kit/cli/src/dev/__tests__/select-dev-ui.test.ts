import { describe, expect, it, vi } from 'vitest'

import { selectDevUi } from 'src/dev/dev-server'
import type { CreateDevUi } from 'src/dev/dev-server'
import type { DevUi } from 'src/dev/dev-ui'

/**
 * `dev/` never imports `tui/`: the live UI arrives as a factory from `entry/dev-server.ts`. These pin
 * the two halves of that seam — the factory is only consulted when the run owns the terminal, and what
 * it builds is the UI the runner gets.
 */
describe('selectDevUi', () => {
  const fakeUi = {} as DevUi

  it('builds the injected UI with a verbose flag and a panel stream when the run owns the terminal', async () => {
    const createDevUi = vi.fn<CreateDevUi>(async () => {
      return fakeUi
    })

    await expect(selectDevUi({ tty: true, json: false, verbose: true }, createDevUi)).resolves.toBe(fakeUi)

    expect(createDevUi).toHaveBeenCalledOnce()
    expect(createDevUi.mock.calls[0]![0]).toMatchObject({
      verbose: true,
      appendLog: expect.any(Function),
      panel: expect.objectContaining({ write: expect.any(Function) }),
    })
  })

  it('never calls the factory for --json, so Ink cannot seize a machine-readable stream', async () => {
    const createDevUi = vi.fn<CreateDevUi>()

    await expect(selectDevUi({ tty: true, json: true }, createDevUi)).resolves.toBeUndefined()
    expect(createDevUi).not.toHaveBeenCalled()
  })

  it('never calls the factory off a TTY', async () => {
    const createDevUi = vi.fn<CreateDevUi>()

    await expect(selectDevUi({ tty: false }, createDevUi)).resolves.toBeUndefined()
    expect(createDevUi).not.toHaveBeenCalled()
  })
})
