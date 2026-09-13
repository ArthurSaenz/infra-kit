import { vi } from 'vitest'

/**
 * Every options object the mocked `$` factory was handed, oldest first.
 *
 * Recorded rather than discarded because it is the ONLY evidence that production code configured the
 * shell at all. A mock that answers a bare `` $`cmd` `` and a `` $({ quiet: true })`cmd` `` identically
 * stays green when the `quiet` is deleted — and `quiet` is the whole fix for a read-only probe printing
 * `command not found` into the user's terminal. Same reasoning, and the same assertion shape, as
 * `src/lib/git-utils/__tests__/zx-command-mock.ts`.
 */
export const zxFactoryArgs: unknown[] = []

/**
 * One entry per command actually run, saying whether it went through a configured shell.
 *
 * `zxFactoryArgs` alone cannot answer that. It records configuration, and a suite in which ANY call
 * site is configured has a non-empty list — so reverting one of several sites to a bare `` $`cmd` ``
 * leaves it green. Recording the tag calls is what makes an unconfigured probe visible, because a bare
 * tag call configures nothing and would otherwise be indistinguishable from not happening.
 */
export const zxTagCalls: { configured: boolean }[] = []

/** Drop what earlier cases recorded. Call from `beforeEach` in any suite that asserts on either list. */
export const resetZxFactoryArgs = (): void => {
  zxFactoryArgs.length = 0
  zxTagCalls.length = 0
}

/**
 * `vi.mock('zx')` factory body for doctor's tests.
 *
 * zx's `$` is BOTH a tagged-template function and a factory: `$({ quiet: true })` returns a configured
 * tag. A mock modelling only the tag call throws the moment production code configures one — at IMPORT
 * if the configuration happens at module scope, which is why four doctor suites broke at once and why
 * there is one helper here rather than four literals.
 *
 * @example
 * vi.mock('zx', async () => {
 *   // Imported INSIDE the factory: `vi.mock` is hoisted above the imports, so a top-level binding is
 *   // still in its TDZ when a module-scope `$` call runs this.
 *   const { zxShellMock } = await import('./zx-shell-mock')
 *
 *   return zxShellMock(() => Promise.resolve({ stdout: '' }))
 * })
 */
export const zxShellMock = (tag: (strings: TemplateStringsArray, command: string[]) => Promise<unknown>) => {
  const record = (configured: boolean) => {
    return (strings: TemplateStringsArray, command: string[]) => {
      zxTagCalls.push({ configured })

      return tag(strings, command)
    }
  }

  return {
    $: vi.fn((first: unknown, second: unknown) => {
      // A bare `` $`cmd` ``: no options were ever supplied, and this is the shape the leak had.
      if (Array.isArray(first)) return record(false)(first as unknown as TemplateStringsArray, second as string[])

      zxFactoryArgs.push(first)

      return record(true)
    }),
  }
}
