import { describe, expect, it, vi } from 'vitest'

import { planDependencies } from 'src/lib/dependency-plan'
import type { ProbeDeps } from 'src/lib/dependency-probe'

/**
 * @fileoverview
 *
 * The one invariant of {@link planDependencies} that no caller can restate: it PROBES all five tools and
 * only then plans the requested subset.
 *
 * This lived in `commands/setup-dependency`'s suite until that command was folded into `setup`, and it
 * moves here rather than to `commands/setup` because it is not a property of either command — both reach
 * the same planner, so pinning it against one of them would leave the other's identical path unguarded
 * and would move again with the next rename.
 */

/** A machine where brew and gh are installed via Homebrew, and everything else is absent. */
const brewAndGhInstalled = (): ProbeDeps => {
  const kegs: Record<string, string> = {
    brew: '/opt/homebrew/bin/brew',
    gh: '/opt/homebrew/Cellar/gh/2.60.0/bin/gh',
  }

  return {
    runCommand: async (argv) => {
      const bin = argv[0] as string

      if (kegs[bin] === undefined) throw new Error('not found')

      return { stdout: `${bin} version 1.2.3` }
    },
    resolveBinPath: async (binName) => {
      return kegs[binName] ?? null
    },
    realpath: (candidate) => {
      return candidate
    },
    platform: 'darwin',
  }
}

describe('the planner probes every tool, then plans the subset it was asked for', () => {
  // Reds on: narrowing the `probeAll` call at `dependency-plan.ts` from DEPENDENCY_IDS to `ids`.
  it('probes brew even when only gh was requested', async () => {
    const deps = brewAndGhInstalled()
    const resolveSpy = vi.spyOn(deps, 'resolveBinPath')

    await planDependencies(['gh'], deps)

    const probed = resolveSpy.mock.calls.map((call) => {
      return call[0]
    })

    expect(probed).toContain('brew')
  })

  /**
   * The consequence, asserted rather than described — this is what makes the test above worth having.
   *
   * `presentManagers` is derived from the probed states, so a planner that probed only the requested ids
   * would decide Homebrew is absent and refuse gh's recipe as `manager-missing`. The refusal is silent
   * and looks like a legitimate safety verdict, which is exactly why it needs a test rather than a
   * comment.
   */
  it('so a single-tool request still plans an EXECUTABLE recipe rather than refusing it', async () => {
    const { plans } = await planDependencies(['gh'], brewAndGhInstalled())

    expect(plans).toHaveLength(1)
    expect(plans[0]?.state.id).toBe('gh')
    expect(plans[0]?.executable, `refused because: ${plans[0]?.refusedBecause.join(', ')}`).toBe(true)
  })

  // The narrowing half: probing all five must not turn into PLANNING all five.
  it('plans only what was requested', async () => {
    const { plans } = await planDependencies(['gh'], brewAndGhInstalled())

    expect(
      plans.map((plan) => {
        return plan.state.id
      }),
    ).toEqual(['gh'])
  })
})
