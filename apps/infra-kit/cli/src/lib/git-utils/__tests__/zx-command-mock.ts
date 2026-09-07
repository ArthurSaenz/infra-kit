import { vi } from 'vitest'

/** What a mocked command answers. `throws` rejects outright; a non-zero `exitCode` depends on `nothrow`. */
export interface FakeCommandResult {
  stdout?: string
  exitCode?: number
  throws?: unknown
}

/** Given the fully interpolated command line, decide what it answers. */
export type CommandResponder = (command: string) => FakeCommandResult

/**
 * A `vi.mock('zx')` factory body whose `$` honours `nothrow` and the `$({ … })` options form.
 *
 * Both properties are load-bearing rather than convenience. Production code calls `$` as
 * `` $`cmd` `` *and* as `` $({ quiet: true })`cmd` ``, so an options-blind mock treats the options
 * object as a command. And a mock that resolves every non-zero exit regardless of `nothrow` cannot
 * distinguish "the command failed and we chose to tolerate it" from "the command failed and the
 * call rejects" — which makes any test about a tolerated failure pass even after `nothrow` is
 * deleted from the code it is guarding.
 *
 * Command answers stay with the test: pass a `respond` callback, which is also the place to record
 * invocations.
 *
 * @example
 * vi.mock('zx', async (importOriginal) => {
 *   const actual = await importOriginal<typeof import('zx')>()
 *   return { ...actual, $: zxCommandMock((command) => (command.includes('git status') ? { stdout: '' } : {})) }
 * })
 */
export const zxCommandMock = (respond: CommandResponder) => {
  const run = (strings: TemplateStringsArray, values: unknown[], nothrow: boolean) => {
    const command = strings
      .reduce((acc, part, index) => {
        return acc + part + (index < values.length ? String(values[index]) : '')
      }, '')
      .trim()

    const result = respond(command)

    if (result.throws !== undefined) return Promise.reject(result.throws)

    const exitCode = result.exitCode ?? 0

    if (exitCode !== 0 && !nothrow) return Promise.reject(new Error(`command exited ${exitCode}: ${command}`))

    return Promise.resolve({ stdout: result.stdout ?? '', exitCode })
  }

  return vi.fn((first: TemplateStringsArray | Record<string, unknown>, ...values: unknown[]) => {
    if (!Array.isArray(first)) {
      const nothrow = Boolean((first as { nothrow?: boolean }).nothrow)

      return (strings: TemplateStringsArray, ...innerValues: unknown[]) => {
        return run(strings, innerValues, nothrow)
      }
    }

    return run(first as TemplateStringsArray, values, false)
  })
}
