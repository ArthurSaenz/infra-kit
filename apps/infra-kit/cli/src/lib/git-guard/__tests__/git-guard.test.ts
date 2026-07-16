import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'

const mocks = vi.hoisted(() => {
  return {
    isInsideLinkedWorktree: vi.fn(),
    isWorkingTreeClean: vi.fn(),
    getCurrentBranch: vi.fn(),
  }
})

vi.mock('src/lib/git-utils', () => {
  return {
    isInsideLinkedWorktree: mocks.isInsideLinkedWorktree,
    isWorkingTreeClean: mocks.isWorkingTreeClean,
    getCurrentBranch: mocks.getCurrentBranch,
  }
})

describe('assertManagementContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: main checkout, clean tree (the all-pass baseline).
    mocks.isInsideLinkedWorktree.mockResolvedValue(false)
    mocks.isWorkingTreeClean.mockResolvedValue(true)
    mocks.getCurrentBranch.mockResolvedValue('feature/x')
  })

  it('resolves when in the main checkout with a clean tree', async () => {
    await expect(assertManagementContext({ operation: 'create release' })).resolves.toBeUndefined()
  })

  it('throws when inside a linked worktree', async () => {
    mocks.isInsideLinkedWorktree.mockResolvedValue(true)

    await expect(assertManagementContext({ operation: 'create release' })).rejects.toMatchObject({
      message: expect.stringContaining('worktree'),
    })
  })

  it('checks the worktree before the tree state', async () => {
    mocks.isInsideLinkedWorktree.mockResolvedValue(true)
    mocks.isWorkingTreeClean.mockResolvedValue(false)

    await expect(assertManagementContext({ operation: 'create release' })).rejects.toThrow(/worktree/)
    expect(mocks.isWorkingTreeClean).not.toHaveBeenCalled()
  })

  it('throws when the working tree is dirty', async () => {
    mocks.isWorkingTreeClean.mockResolvedValue(false)

    await expect(assertManagementContext({ operation: 'create release' })).rejects.toMatchObject({
      message: expect.stringContaining('commit or stash'),
    })
  })

  it('throws OperationError (not a plain Error) on violation', async () => {
    mocks.isWorkingTreeClean.mockResolvedValue(false)

    await expect(assertManagementContext({ operation: 'sync worktrees' })).rejects.toBeInstanceOf(OperationError)
  })

  // The guard is deliberately branch-blind: commands that need a canonical
  // branch switch onto it themselves, after their own confirmation prompt. A
  // branch check here would run before consent, so a cancelled command would
  // still have moved the operator's checkout.
  it('ignores the current branch entirely', async () => {
    mocks.getCurrentBranch.mockResolvedValue('some/unrelated-branch')

    await expect(assertManagementContext({ operation: 'create worktrees' })).resolves.toBeUndefined()
    expect(mocks.getCurrentBranch).not.toHaveBeenCalled()
  })
})
