import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { removeWorktrees } from '../remove-worktrees'

// `$` resolves to a bare awaitable result — removeWorktrees only ever `await`s
// the tagged template (no `.quiet()`/`.nothrow()` chaining anymore), so a plain
// resolved promise is a faithful stand-in.
vi.mock('zx', () => {
  return {
    $: vi.fn(() => {
      return Promise.resolve({ stdout: '', exitCode: 0 })
    }),
  }
})

vi.mock('src/integrations/cmux', () => {
  return {
    buildCmuxWorkspaceTitle: vi.fn(({ repoName, branch }: { repoName: string; branch: string }) => {
      return `${repoName}:${branch}`
    }),
    closeCmuxWorkspaceByTitle: vi.fn(() => {
      return Promise.resolve()
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return {
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }
})

type DollarCall = [TemplateStringsArray, ...unknown[]]

/** Reconstruct the full command string for a recorded `$` tagged-template call. */
const commandOf = (call: DollarCall): string => {
  const [strings, ...values] = call

  return strings.reduce((acc, part, index) => {
    const value = index < values.length ? String(values[index]) : ''

    return acc + part + value
  }, '')
}

/** Interpolated `${...}` arguments of a recorded `$` call (the dynamic paths). */
const argsOf = (call: DollarCall): string[] => {
  return call.slice(1).map((value) => {
    return String(value)
  })
}

const recordedCalls = (): DollarCall[] => {
  return vi.mocked($).mock.calls as unknown as DollarCall[]
}

const WORKTREE_DIR = '/repos/hulyo-monorepo-worktrees'
const REPO_NAME = 'hulyo-monorepo'

describe('removeWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('removes each leaf worktree and returns the removed branches', async () => {
    const branches = ['release/1.2.5', 'feature/foo']

    const removed = await removeWorktrees({ branches, worktreeDir: WORKTREE_DIR, repoName: REPO_NAME })

    expect(removed).toEqual(branches)

    const removeCommands = recordedCalls()
      .map(commandOf)
      .filter((command) => {
        return command.startsWith('git worktree remove ')
      })

    expect(removeCommands).toContain(`git worktree remove ${WORKTREE_DIR}/release/1.2.5`)
    expect(removeCommands).toContain(`git worktree remove ${WORKTREE_DIR}/feature/foo`)
  })

  it('never deletes the worktrees container or its group subdirs (regression)', async () => {
    const branches = ['release/1.2.5', 'release/1.2.6']

    await removeWorktrees({ branches, worktreeDir: WORKTREE_DIR, repoName: REPO_NAME, pruneFolder: true })

    const calls = recordedCalls()
    const commands = calls.map(commandOf)

    // No destructive directory removal of any kind.
    expect(
      commands.some((command) => {
        return command.includes('rm -rf')
      }),
    ).toBe(false)
    expect(
      commands.some((command) => {
        return command.includes('rmdir')
      }),
    ).toBe(false)

    // Invariant: no `$` call ever targets the bare parent worktreeDir as an
    // interpolated argument — guards against any future deletion mechanism.
    const targetsBareParent = calls.some((call) => {
      return argsOf(call).includes(WORKTREE_DIR)
    })

    expect(targetsBareParent).toBe(false)
  })

  it('runs `git worktree prune` when pruneFolder is set and every branch was removed', async () => {
    const branches = ['release/1.2.5']

    await removeWorktrees({ branches, worktreeDir: WORKTREE_DIR, repoName: REPO_NAME, pruneFolder: true })

    const prunedCalls = recordedCalls()
      .map(commandOf)
      .filter((command) => {
        return command === 'git worktree prune'
      })

    expect(prunedCalls).toHaveLength(1)
  })

  it('does not run `git worktree prune` when pruneFolder is false', async () => {
    const branches = ['release/1.2.5']

    await removeWorktrees({ branches, worktreeDir: WORKTREE_DIR, repoName: REPO_NAME, pruneFolder: false })

    const pruned = recordedCalls().map(commandOf).includes('git worktree prune')

    expect(pruned).toBe(false)
  })

  it('skips `git worktree prune` when a branch removal fails (not every branch removed)', async () => {
    const branches = ['release/1.2.5', 'release/1.2.6']

    // Reject the `git worktree remove` for the second branch so it is not counted
    // in `removed`, leaving `removed.length !== branches.length`. Cast the whole
    // impl to `typeof $` since zx's `$` is a multi-overload callable.
    const failingDollar = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const command = commandOf([strings, ...values])

      if (command === `git worktree remove ${WORKTREE_DIR}/release/1.2.6`) {
        return Promise.reject(new Error('uncommitted changes block removal'))
      }

      return Promise.resolve({ stdout: '', exitCode: 0 })
    }

    vi.mocked($).mockImplementation(failingDollar as unknown as typeof $)

    const removed = await removeWorktrees({
      branches,
      worktreeDir: WORKTREE_DIR,
      repoName: REPO_NAME,
      pruneFolder: true,
    })

    expect(removed).toEqual(['release/1.2.5'])

    const pruned = recordedCalls().map(commandOf).includes('git worktree prune')

    expect(pruned).toBe(false)
  })
})
