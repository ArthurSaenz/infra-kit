import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listCmuxWorkspaceTitles, openCmuxWorkspaceWithLayout } from 'src/integrations/cmux'
import { getRepoName } from 'src/lib/git-utils'

import { openCmux } from '../worktrees-open'

vi.mock('src/integrations/cmux', async (importActual) => {
  const actual = await importActual<typeof import('src/integrations/cmux')>()

  return {
    ...actual,
    listCmuxWorkspaceTitles: vi.fn(),
    openCmuxWorkspaceWithLayout: vi.fn(),
  }
})

vi.mock('src/lib/git-utils', () => {
  return {
    getRepoName: vi.fn(),
    getProjectRoot: vi.fn(),
    getCurrentWorktrees: vi.fn(),
  }
})

const REPO = 'hulyo-monorepo'
const WORKTREE_DIR = '/repos/project-worktrees'
const BRANCHES = ['release/v1.48.0', 'release/checkout-redesign']

const titleFor = {
  versioned: `${REPO} 1.48.0`,
  named: `${REPO} checkout-redesign`,
}

describe('openCmux dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRepoName).mockResolvedValue(REPO)
    vi.mocked(openCmuxWorkspaceWithLayout).mockResolvedValue(undefined)
  })

  it('opens a workspace for every branch when none are open', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set())

    const result = await openCmux({ worktreeDir: WORKTREE_DIR, currentBranches: BRANCHES })

    expect(result.opened).toEqual([titleFor.versioned, titleFor.named])
    expect(result.skipped).toEqual([])
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(2)
  })

  it('skips every branch when all are already open (no duplicates)', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set([titleFor.versioned, titleFor.named]))

    const result = await openCmux({ worktreeDir: WORKTREE_DIR, currentBranches: BRANCHES })

    expect(result.opened).toEqual([])
    expect(result.skipped).toEqual([titleFor.versioned, titleFor.named])
    expect(openCmuxWorkspaceWithLayout).not.toHaveBeenCalled()
  })

  it('opens only the missing branch in a mixed state', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set([titleFor.versioned]))

    const result = await openCmux({ worktreeDir: WORKTREE_DIR, currentBranches: BRANCHES })

    expect(result.skipped).toEqual([titleFor.versioned])
    expect(result.opened).toEqual([titleFor.named])
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(1)
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledWith({
      cwd: `${WORKTREE_DIR}/release/checkout-redesign`,
      title: titleFor.named,
    })
  })

  it('skips a versioned branch whose workspace was stored under an old v-prefixed title', async () => {
    // listCmuxWorkspaceTitles already returns canonical keys, so an old
    // "hulyo-monorepo v1.48.0" workspace is surfaced as the canonical key below.
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set([titleFor.versioned]))

    const result = await openCmux({ worktreeDir: WORKTREE_DIR, currentBranches: ['release/v1.48.0'] })

    expect(result.opened).toEqual([])
    expect(result.skipped).toEqual([titleFor.versioned])
    expect(openCmuxWorkspaceWithLayout).not.toHaveBeenCalled()
  })

  it('returns empty outcome when there are no worktrees', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set())

    const result = await openCmux({ worktreeDir: WORKTREE_DIR, currentBranches: [] })

    expect(result).toEqual({ ran: true, opened: [], skipped: [] })
    expect(listCmuxWorkspaceTitles).not.toHaveBeenCalled()
  })
})
