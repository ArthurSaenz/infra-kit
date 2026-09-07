import { beforeEach, describe, expect, it, vi } from 'vitest'

import { expectRejection } from 'src/lib/errors/__tests__/expect-rejection'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertBaseBranchSwitchable, assertCleanCheckout, assertManagementContext } from 'src/lib/git-guard'

const mocks = vi.hoisted(() => {
  return {
    isInsideLinkedWorktree: vi.fn(),
    isWorkingTreeClean: vi.fn(),
    getCurrentBranch: vi.fn(),
    getWorkingTreeStatus: vi.fn(),
    getProjectRoot: vi.fn(),
    listWorktrees: vi.fn(),
  }
})

vi.mock('src/lib/git-utils', () => {
  return {
    isInsideLinkedWorktree: mocks.isInsideLinkedWorktree,
    isWorkingTreeClean: mocks.isWorkingTreeClean,
    getCurrentBranch: mocks.getCurrentBranch,
    getWorkingTreeStatus: mocks.getWorkingTreeStatus,
    getProjectRoot: mocks.getProjectRoot,
    listWorktrees: mocks.listWorktrees,
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

describe('assertManagementContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: main checkout, clean tree (the all-pass baseline).
    mocks.isInsideLinkedWorktree.mockResolvedValue(false)
    mocks.isWorkingTreeClean.mockResolvedValue(true)
    mocks.getCurrentBranch.mockResolvedValue('feature/x')
    mocks.getWorkingTreeStatus.mockResolvedValue([])
    mocks.getProjectRoot.mockResolvedValue('/repo')
    mocks.listWorktrees.mockResolvedValue([
      { path: '/repo', branch: 'feature/x', detached: false, bare: false, prunable: false, locked: false },
    ])
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
    mocks.getWorkingTreeStatus.mockResolvedValue(['M src/foo.ts'])

    await expect(assertManagementContext({ operation: 'create release' })).rejects.toThrow(/worktree/)
    expect(mocks.getWorkingTreeStatus).not.toHaveBeenCalled()
  })

  it('throws when the working tree is dirty', async () => {
    mocks.getWorkingTreeStatus.mockResolvedValue(['M src/foo.ts'])

    await expect(assertManagementContext({ operation: 'create release' })).rejects.toMatchObject({
      message: expect.stringContaining('commit or stash'),
    })
  })

  it('throws OperationError (not a plain Error) on violation', async () => {
    mocks.getWorkingTreeStatus.mockResolvedValue(['M src/foo.ts'])

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

describe('assertCleanCheckout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWorkingTreeStatus.mockResolvedValue([])
  })

  it('resolves on a clean tree', async () => {
    await expect(assertCleanCheckout({ operation: 'create release' })).resolves.toBeUndefined()
  })

  it('names the offending paths and how to clear them', async () => {
    mocks.getWorkingTreeStatus.mockResolvedValue(['M src/foo.ts', '?? scratch.md'])

    const error = await expectRejection(assertCleanCheckout({ operation: 'create release' }))

    expect(error).toBeInstanceOf(OperationError)
    expect(error.message).toContain('M src/foo.ts')
    expect(error.message).toContain('?? scratch.md')
    expect(error.message).toContain('git stash -u')
  })

  // The single-line OperationError is byte-capped, so a realistic status cannot fit. What must
  // survive truncation is an HONEST count: the summary is built from the real total, never from
  // the slice it prints, or the operator is told fewer files block them than actually do.
  it('summarises the overflow with a count taken from the full status', async () => {
    const status = Array.from({ length: 10 }, (_, index) => {
      return `M src/file-${index}.ts`
    })

    mocks.getWorkingTreeStatus.mockResolvedValue(status)

    const error = await expectRejection(assertCleanCheckout({ operation: 'create release' }))

    expect(error.stderrExcerpt).toContain('(+6 more)')
  })

  // The reason the field exists: `executeOne` re-wraps every per-entry failure, and a plain
  // one-level stderr read returns nothing for an OperationError, so the paths would vanish from
  // the message the operator and the MCP client actually see.
  it('survives being re-wrapped in another OperationError', async () => {
    mocks.getWorkingTreeStatus.mockResolvedValue(['M src/foo.ts'])

    const inner = await expectRejection(assertCleanCheckout({ operation: 'create release' }))

    const outer = new OperationError(inner, {
      operation: 'create release 1.2.3 (regular)',
      remediation: 'verify the version or name is unique',
    })

    expect(outer.message).toContain('M src/foo.ts')
  })
})

describe('assertBaseBranchSwitchable', () => {
  const worktree = (path: string, branch: string | null) => {
    return { path, branch, detached: false, bare: false, prunable: false, locked: false }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getProjectRoot.mockResolvedValue('/repo')
    mocks.getCurrentBranch.mockResolvedValue('feature/x')
    mocks.listWorktrees.mockResolvedValue([worktree('/repo', 'feature/x')])
  })

  it('resolves when no worktree holds the base branch', async () => {
    await expect(assertBaseBranchSwitchable({ operation: 'create release', base: 'dev' })).resolves.toBeUndefined()
  })

  // `listWorktrees` reports the main checkout as its own record, so an operator already standing
  // on the base branch looks exactly like a worktree "holding" it. Short-circuiting on branch
  // identity first is what keeps the most ordinary invocation from being refused.
  it('resolves when the current checkout is itself on the base branch', async () => {
    mocks.getCurrentBranch.mockResolvedValue('dev')
    mocks.listWorktrees.mockResolvedValue([worktree('/repo', 'dev')])

    await expect(assertBaseBranchSwitchable({ operation: 'create release', base: 'dev' })).resolves.toBeUndefined()
  })

  it('refuses and names the holding worktree', async () => {
    mocks.listWorktrees.mockResolvedValue([worktree('/repo', 'feature/x'), worktree('/repo-worktrees/dev', 'dev')])

    await expect(assertBaseBranchSwitchable({ operation: 'create release', base: 'dev' })).rejects.toMatchObject({
      message: expect.stringContaining('/repo-worktrees/dev'),
    })
  })

  it('ignores detached and branch-less worktrees', async () => {
    mocks.listWorktrees.mockResolvedValue([worktree('/repo', 'feature/x'), worktree('/repo/.git/scratch', null)])

    await expect(assertBaseBranchSwitchable({ operation: 'create release', base: 'dev' })).resolves.toBeUndefined()
  })

  // A worktree holding a DIFFERENT branch must not block us. Without this the previous case proves
  // nothing: `null === 'dev'` is false under any predicate, including a path-based one, so it
  // cannot fail. Matching has to be keyed on the branch we are actually about to switch to.
  it('does not refuse because some other branch is held', async () => {
    mocks.listWorktrees.mockResolvedValue([worktree('/repo', 'feature/x'), worktree('/repo-worktrees/main', 'main')])

    await expect(assertBaseBranchSwitchable({ operation: 'create release', base: 'dev' })).resolves.toBeUndefined()
  })

  // The holder is identified by branch, never by path: `listWorktrees` reports git's
  // symlink-resolved paths while `getProjectRoot` reports `--show-toplevel`, and on macOS those
  // disagree (/var vs /private/var). A path-equality predicate would refuse this case.
  it('short-circuits on branch identity even when the reported paths disagree', async () => {
    mocks.getCurrentBranch.mockResolvedValue('dev')
    mocks.getProjectRoot.mockResolvedValue('/var/folders/repo')
    mocks.listWorktrees.mockResolvedValue([worktree('/private/var/folders/repo', 'dev')])

    await expect(assertBaseBranchSwitchable({ operation: 'create release', base: 'dev' })).resolves.toBeUndefined()
  })
})
