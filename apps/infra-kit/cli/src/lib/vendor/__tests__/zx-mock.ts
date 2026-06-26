import { vi } from 'vitest'

/**
 * Shared spy for every `zx` subprocess call in the vendor write-path tests.
 * Tests assert against it, e.g. `expect(execMock).not.toHaveBeenCalled()`.
 */
export const execMock = vi.fn(() => {
  return Promise.resolve({ stdout: '' })
})

/**
 * `vi.mock('zx')` factory body. Returns a `$` handling both the tagged-template
 * `` $`cmd` `` and the `$({ cwd })` options form, routing every call through
 * {@link execMock}. Referencing this imported function (rather than a top-level
 * const) keeps the hoisted `vi.mock` factory hoist-safe.
 *
 * @example
 * vi.mock('zx', () => zxModuleMock())
 */
export const zxModuleMock = () => {
  const $ = (first: unknown) => {
    if (Array.isArray(first)) {
      return execMock()
    }

    return () => {
      return execMock()
    }
  }

  return { $ }
}
