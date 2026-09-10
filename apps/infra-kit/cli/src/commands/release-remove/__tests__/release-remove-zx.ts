import { zxCommandMock } from 'src/lib/git-utils/__tests__/zx-command-mock'

/**
 * The `zx` half of the `release remove` test harness, split into its own module for one reason: a
 * `vi.mock('zx')` factory has to `await import(…)` its helper (the importing file's own bindings are
 * still in their temporal dead zone when the factory runs), and anything that helper transitively
 * imports is loaded WHILE the zx mock is being built. This module imports nothing but the shared
 * `zxCommandMock`, so that graph can never reach a production module that itself imports `zx`.
 *
 * Recording rather than executing is what lets a suite assert a NEGATIVE — that `gh pr close` was
 * never reached, or that `git switch` preceded the branch delete. Mocking `fetchPRByHead` alone
 * cannot say either of those things.
 */

/** Recorded shell invocations, plus per-command answers keyed by substring of the command line. */
export interface ZxState {
  commands: string[]
  overrides: { match: string; stdout?: string; throws?: unknown }[]
}

export const createZx = (state: ZxState) => {
  return zxCommandMock((command) => {
    state.commands.push(command)

    const override = state.overrides.find((entry) => {
      return command.includes(entry.match)
    })

    if (!override) return { stdout: '' }
    if (override.throws !== undefined) return { throws: override.throws }

    return { stdout: override.stdout ?? '' }
  })
}

export const ranCommand = (state: ZxState, needle: string): boolean => {
  return state.commands.some((command) => {
    return command.includes(needle)
  })
}
