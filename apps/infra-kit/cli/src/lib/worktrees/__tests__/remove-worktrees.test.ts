import fs from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { listWorktrees } from 'src/lib/git-utils'
import type { WorktreeEntry } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'

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
    closeCmuxWorkspaceByCwd: vi.fn(() => {
      return Promise.resolve()
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return {
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }
})

// The registration check is NOT routed through the `$` mock: `listWorktrees` uses the curried
// `$({ cwd })` form, which the flat `$` stub above cannot serve. Drive it with entry fixtures.
vi.mock('src/lib/git-utils', () => {
  return { listWorktrees: vi.fn() }
})

// Default import in the implementation — a named `import { rm }` would bypass this mock and hit
// the real filesystem (memory: vi.spyOn can't intercept named fs imports).
vi.mock('node:fs/promises', () => {
  return { default: { readdir: vi.fn(), realpath: vi.fn(), rm: vi.fn() } }
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

const PROJECT_ROOT = '/repos/hulyo-monorepo'
const WORKTREE_DIR = '/repos/hulyo-monorepo-worktrees'
const BRANCH = 'release/1.2.6'
const BRANCH_PATH = `${WORKTREE_DIR}/${BRANCH}`

const GIT_DIRTY_STDERR = "fatal: '/repos/x' contains modified or untracked files, use --force to delete it"

const entryFor = (path: string): WorktreeEntry => {
  return { path, branch: null, detached: false, bare: false, prunable: false, locked: false }
}

const registeredPaths = (...paths: string[]): void => {
  vi.mocked(listWorktrees).mockResolvedValue([entryFor(PROJECT_ROOT), ...paths.map(entryFor)])
}

/** Make `git worktree remove <path>` reject the way zx does (stderr + exitCode on the error). */
const rejectRemoveOf = (path: string): void => {
  const failingDollar = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (commandOf([strings, ...values]) === `git worktree remove ${path}`) {
      return Promise.reject(
        Object.assign(new Error('git worktree remove failed'), { stderr: GIT_DIRTY_STDERR, exitCode: 128 }),
      )
    }

    return Promise.resolve({ stdout: '', exitCode: 0 })
  }

  vi.mocked($).mockImplementation(failingDollar as unknown as typeof $)
}

/** Leftover directory fixture: `top` at the worktree path, `omc` inside `.omc` (when present). */
const leftover = (top: string[], omc: string[] = []): void => {
  vi.mocked(fs.readdir).mockImplementation(((path: string) => {
    return Promise.resolve(path.endsWith('/.omc') ? omc : top)
  }) as unknown as typeof fs.readdir)
}

const enoent = (): NodeJS.ErrnoException => {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

const enotempty = (): NodeJS.ErrnoException => {
  return Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' })
}

const noSleep = vi.fn((): Promise<void> => {
  return Promise.resolve()
})

const remove = (branches: string[], pruneFolder = false) => {
  return removeWorktrees({
    branches,
    worktreeDir: WORKTREE_DIR,
    projectRoot: PROJECT_ROOT,
    pruneFolder,
    sleep: noSleep,
  })
}

beforeEach(() => {
  vi.clearAllMocks()

  vi.mocked($).mockImplementation((() => {
    return Promise.resolve({ stdout: '', exitCode: 0 })
  }) as unknown as typeof $)

  // Identity realpath by default; individual tests override to model /var → /private/var.
  vi.mocked(fs.realpath).mockImplementation(((path: string) => {
    return Promise.resolve(path)
  }) as unknown as typeof fs.realpath)
  vi.mocked(fs.rm).mockResolvedValue(undefined)
  vi.mocked(fs.readdir).mockRejectedValue(enoent())
  registeredPaths()
})

describe('removeWorktrees — happy path and scaffold invariants', () => {
  it('removes each leaf worktree and returns the removed branches with no failures', async () => {
    const branches = ['release/1.2.5', 'feature/foo']

    const result = await remove(branches)

    expect(result).toEqual({ removed: branches, failed: [] })

    const removeCommands = recordedCalls()
      .map(commandOf)
      .filter((command) => {
        return command.startsWith('git worktree remove ')
      })

    expect(removeCommands).toContain(`git worktree remove ${WORKTREE_DIR}/release/1.2.5`)
    expect(removeCommands).toContain(`git worktree remove ${WORKTREE_DIR}/feature/foo`)
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(fs.rm).not.toHaveBeenCalled()
  })

  it('never deletes the worktrees container or its group subdirs (regression)', async () => {
    const branches = ['release/1.2.5', 'release/1.2.6']

    await remove(branches, true)

    const calls = recordedCalls()
    const commands = calls.map(commandOf)

    // No destructive directory removal of any kind through the shell.
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
    expect(fs.rm).not.toHaveBeenCalled()
  })

  it('runs `git worktree prune` when pruneFolder is set and every branch was removed', async () => {
    await remove(['release/1.2.5'], true)

    const prunedCalls = recordedCalls()
      .map(commandOf)
      .filter((command) => {
        return command === 'git worktree prune'
      })

    expect(prunedCalls).toHaveLength(1)
  })

  it('does not run `git worktree prune` when pruneFolder is false', async () => {
    await remove(['release/1.2.5'], false)

    const pruned = recordedCalls().map(commandOf).includes('git worktree prune')

    expect(pruned).toBe(false)
  })
})

describe('removeWorktrees — a rejected `git worktree remove`', () => {
  it('(a) reports a still-registered worktree as failed with the git stderr, and never sweeps', async () => {
    registeredPaths(BRANCH_PATH)
    rejectRemoveOf(BRANCH_PATH)

    const result = await remove(['release/1.2.5', BRANCH], true)

    expect(result.removed).toEqual(['release/1.2.5'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.branch).toBe(BRANCH)
    expect(result.failed[0]?.reason).toMatch(/modified or untracked/)
    expect(result.failed[0]?.reason).toMatch(/uncommitted changes block removal/)
    expect(fs.rm).not.toHaveBeenCalled()
    expect(fs.readdir).not.toHaveBeenCalled()

    // Not every branch removed → no prune.
    expect(recordedCalls().map(commandOf).includes('git worktree prune')).toBe(false)
  })

  it('(b) sweeps an unregistered leftover made only of .omc/{state,sessions} and .DS_Store', async () => {
    rejectRemoveOf(BRANCH_PATH)
    leftover(['.omc', '.DS_Store'], ['state', 'sessions'])

    const result = await remove([BRANCH], true)

    expect(result).toEqual({ removed: [BRANCH], failed: [] })
    expect(fs.rm).toHaveBeenCalledTimes(1)
    expect(fs.rm).toHaveBeenCalledWith(BRANCH_PATH, { recursive: true, force: true })

    const warning = String(vi.mocked(logger.warn).mock.calls[0]?.[0])

    expect(warning).toContain('.omc, .DS_Store')
    expect(warning).toContain(BRANCH_PATH)
    expect(warning).toContain('OMC_STATE_DIR')

    // Every branch removed (via sweep) → prune runs.
    expect(recordedCalls().map(commandOf).includes('git worktree prune')).toBe(true)
  })

  it('(c) refuses to sweep an unregistered leftover that holds anything else', async () => {
    rejectRemoveOf(BRANCH_PATH)
    leftover(['.omc', 'src'], ['state'])

    const result = await remove([BRANCH])

    expect(result.removed).toEqual([])
    expect(result.failed[0]?.branch).toBe(BRANCH)
    expect(result.failed[0]?.reason).toContain(`rm -r ${BRANCH_PATH}`)
    expect(fs.rm).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('(d) retries the sweep exactly once after the injected sleep when ENOTEMPTY recurs', async () => {
    rejectRemoveOf(BRANCH_PATH)
    leftover(['.omc'], ['state'])
    vi.mocked(fs.rm).mockRejectedValueOnce(enotempty())

    const result = await remove([BRANCH])

    expect(result).toEqual({ removed: [BRANCH], failed: [] })
    expect(fs.rm).toHaveBeenCalledTimes(2)
    expect(noSleep).toHaveBeenCalledTimes(1)
    expect(noSleep).toHaveBeenCalledWith(2000)
  })

  it('(d′) gives up after the second ENOTEMPTY and reports the branch as failed', async () => {
    rejectRemoveOf(BRANCH_PATH)
    leftover(['.omc'], ['state'])
    vi.mocked(fs.rm).mockRejectedValue(enotempty())

    const result = await remove([BRANCH])

    expect(result.removed).toEqual([])
    expect(result.failed[0]?.branch).toBe(BRANCH)
    expect(fs.rm).toHaveBeenCalledTimes(2)
  })

  it('(d″) does not retry on a non-ENOTEMPTY sweep error', async () => {
    rejectRemoveOf(BRANCH_PATH)
    leftover(['.omc'], ['state'])
    vi.mocked(fs.rm).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))

    const result = await remove([BRANCH])

    expect(result.failed[0]?.branch).toBe(BRANCH)
    expect(fs.rm).toHaveBeenCalledTimes(1)
    expect(noSleep).not.toHaveBeenCalled()
  })

  it('(e) counts an unregistered path whose directory is already gone as removed', async () => {
    rejectRemoveOf(BRANCH_PATH)
    vi.mocked(fs.readdir).mockRejectedValue(enoent())

    const result = await remove([BRANCH])

    expect(result).toEqual({ removed: [BRANCH], failed: [] })
    expect(fs.rm).not.toHaveBeenCalled()
  })

  it('(g) refuses to sweep when .omc holds anything beyond state/sessions (e.g. committable skills)', async () => {
    rejectRemoveOf(BRANCH_PATH)
    leftover(['.omc'], ['state', 'skills'])

    const result = await remove([BRANCH])

    expect(result.failed[0]?.branch).toBe(BRANCH)
    expect(fs.rm).not.toHaveBeenCalled()
  })

  it('(h) asks git about registration from the project root, never from the worktrees container', async () => {
    rejectRemoveOf(BRANCH_PATH)
    leftover(['.omc'], ['state'])

    await remove([BRANCH])

    expect(listWorktrees).toHaveBeenCalledTimes(1)
    expect(listWorktrees).toHaveBeenCalledWith(PROJECT_ROOT)
  })

  it('treats a failing registration check as "still registered" and never sweeps', async () => {
    rejectRemoveOf(BRANCH_PATH)
    vi.mocked(listWorktrees).mockRejectedValue(new Error('fatal: not a git repository'))
    leftover(['.omc'], ['state'])

    const result = await remove([BRANCH])

    expect(result.failed[0]?.branch).toBe(BRANCH)
    expect(fs.rm).not.toHaveBeenCalled()
  })

  it('matches a registered path through realpath (macOS /var → /private/var) and reports it as failed', async () => {
    registeredPaths(`/private${BRANCH_PATH}`)
    rejectRemoveOf(BRANCH_PATH)
    leftover(['.omc'], ['state'])
    vi.mocked(fs.realpath).mockImplementation(((path: string) => {
      return Promise.resolve(path.startsWith('/private') ? path : `/private${path}`)
    }) as unknown as typeof fs.realpath)

    const result = await remove([BRANCH])

    expect(result.failed[0]?.branch).toBe(BRANCH)
    expect(fs.rm).not.toHaveBeenCalled()
  })

  it('treats a read error other than ENOENT on the leftover as not sweepable', async () => {
    rejectRemoveOf(BRANCH_PATH)
    vi.mocked(fs.readdir).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))

    const result = await remove([BRANCH])

    expect(result.failed[0]?.branch).toBe(BRANCH)
    expect(fs.rm).not.toHaveBeenCalled()
  })

  it('reports a cmux close failure as failed WITHOUT running git or the post-git recovery', async () => {
    const { closeCmuxWorkspaceByCwd } = await import('src/integrations/cmux')

    vi.mocked(closeCmuxWorkspaceByCwd).mockRejectedValueOnce(new Error('cmux: workspace busy'))

    const result = await remove([BRANCH])

    expect(result.removed).toEqual([])
    expect(result.failed[0]?.branch).toBe(BRANCH)
    expect(result.failed[0]?.reason).toMatch(/close the cmux workspace/)
    expect(recordedCalls().map(commandOf)).not.toContain(`git worktree remove ${BRANCH_PATH}`)
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(fs.rm).not.toHaveBeenCalled()
  })
})
