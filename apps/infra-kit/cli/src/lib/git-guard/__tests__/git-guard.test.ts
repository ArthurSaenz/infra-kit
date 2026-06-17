import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'

const mocks = vi.hoisted(() => {
  return {
    isInsideLinkedWorktree: vi.fn(),
    getCurrentBranch: vi.fn(),
    isWorkingTreeClean: vi.fn(),
  }
})

vi.mock('src/lib/git-utils', () => {
  return {
    isInsideLinkedWorktree: mocks.isInsideLinkedWorktree,
    getCurrentBranch: mocks.getCurrentBranch,
    isWorkingTreeClean: mocks.isWorkingTreeClean,
  }
})

describe('assertManagementContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: main checkout, on dev, clean tree (the all-pass baseline).
    mocks.isInsideLinkedWorktree.mockResolvedValue(false)
    mocks.getCurrentBranch.mockResolvedValue('dev')
    mocks.isWorkingTreeClean.mockResolvedValue(true)
  })

  it('resolves when in main checkout, on the required branch, with a clean tree', async () => {
    await expect(
      assertManagementContext({ operation: 'create release', requiredBranch: 'dev' }),
    ).resolves.toBeUndefined()
  })

  it('throws when inside a linked worktree', async () => {
    mocks.isInsideLinkedWorktree.mockResolvedValue(true)

    await expect(assertManagementContext({ operation: 'create release', requiredBranch: 'dev' })).rejects.toMatchObject(
      {
        message: expect.stringContaining('worktree'),
      },
    )
  })

  it('checks the worktree before the branch', async () => {
    mocks.isInsideLinkedWorktree.mockResolvedValue(true)
    mocks.getCurrentBranch.mockResolvedValue('feature/x')

    await expect(assertManagementContext({ operation: 'create release', requiredBranch: 'dev' })).rejects.toThrow(
      /worktree/,
    )
    expect(mocks.getCurrentBranch).not.toHaveBeenCalled()
  })

  it('throws on the wrong branch when requiredBranch is set', async () => {
    mocks.getCurrentBranch.mockResolvedValue('main')

    await expect(assertManagementContext({ operation: 'create release', requiredBranch: 'dev' })).rejects.toMatchObject(
      {
        message: expect.stringContaining('switch to dev'),
      },
    )
  })

  it('skips the branch check when requiredBranch is omitted', async () => {
    mocks.getCurrentBranch.mockResolvedValue('main')

    await expect(assertManagementContext({ operation: 'deliver release' })).resolves.toBeUndefined()
    expect(mocks.getCurrentBranch).not.toHaveBeenCalled()
  })

  it('throws when the working tree is dirty', async () => {
    mocks.isWorkingTreeClean.mockResolvedValue(false)

    await expect(assertManagementContext({ operation: 'create release', requiredBranch: 'dev' })).rejects.toMatchObject(
      {
        message: expect.stringContaining('commit or stash'),
      },
    )
  })

  it('throws OperationError (not a plain Error) on violation', async () => {
    mocks.isWorkingTreeClean.mockResolvedValue(false)

    await expect(
      assertManagementContext({ operation: 'sync worktrees', requiredBranch: 'dev' }),
    ).rejects.toBeInstanceOf(OperationError)
  })
})
