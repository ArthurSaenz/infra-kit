import { beforeEach, describe, expect, it, vi } from 'vitest'

import { closeCmuxWorkspaceByTitle, listCmuxWorkspaceTitles, openCmuxWorkspaceWithLayout } from 'src/integrations/cmux'
import { getRepoName } from 'src/lib/git-utils'

import { closeCmux, reopenCmux } from '../worktrees-reload'

vi.mock('src/integrations/cmux', async (importActual) => {
  const actual = await importActual<typeof import('src/integrations/cmux')>()

  return {
    ...actual,
    listCmuxWorkspaceTitles: vi.fn(),
    closeCmuxWorkspaceByTitle: vi.fn(),
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

describe('closeCmux', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRepoName).mockResolvedValue(REPO)
    vi.mocked(closeCmuxWorkspaceByTitle).mockResolvedValue(undefined)
  })

  it('closes only the branches whose workspace is open in the snapshot', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set([titleFor.versioned]))

    const closed = await closeCmux({ currentBranches: BRANCHES, repoName: REPO })

    expect(closed).toEqual([titleFor.versioned])
    expect(closeCmuxWorkspaceByTitle).toHaveBeenCalledTimes(1)
    expect(closeCmuxWorkspaceByTitle).toHaveBeenCalledWith(titleFor.versioned)
  })

  it('closes every open branch when all are present in the snapshot', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set([titleFor.versioned, titleFor.named]))

    const closed = await closeCmux({ currentBranches: BRANCHES, repoName: REPO })

    expect(closed).toEqual([titleFor.versioned, titleFor.named])
    expect(closeCmuxWorkspaceByTitle).toHaveBeenCalledTimes(2)
  })

  it('closes nothing when none are open', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set())

    const closed = await closeCmux({ currentBranches: BRANCHES, repoName: REPO })

    expect(closed).toEqual([])
    expect(closeCmuxWorkspaceByTitle).not.toHaveBeenCalled()
  })

  it('returns [] and skips the snapshot when there are no worktrees', async () => {
    const closed = await closeCmux({ currentBranches: [], repoName: REPO })

    expect(closed).toEqual([])
    expect(listCmuxWorkspaceTitles).not.toHaveBeenCalled()
    expect(closeCmuxWorkspaceByTitle).not.toHaveBeenCalled()
  })
})

describe('reopenCmux', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRepoName).mockResolvedValue(REPO)
    vi.mocked(openCmuxWorkspaceWithLayout).mockResolvedValue(undefined)
  })

  it('force-opens a workspace for every branch (no dedup)', async () => {
    const result = await reopenCmux({ worktreeDir: WORKTREE_DIR, currentBranches: BRANCHES, repoName: REPO })

    expect(result.opened).toEqual([titleFor.versioned, titleFor.named])
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(2)
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledWith({
      cwd: `${WORKTREE_DIR}/release/v1.48.0`,
      title: titleFor.versioned,
    })
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledWith({
      cwd: `${WORKTREE_DIR}/release/checkout-redesign`,
      title: titleFor.named,
    })
  })

  it('continues past a per-branch failure and reopens the rest', async () => {
    vi.mocked(openCmuxWorkspaceWithLayout)
      .mockRejectedValueOnce(new Error('cmux boom'))
      .mockResolvedValueOnce(undefined)

    const result = await reopenCmux({ worktreeDir: WORKTREE_DIR, currentBranches: BRANCHES, repoName: REPO })

    expect(result.opened).toEqual([titleFor.named])
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(2)
  })

  it('opens nothing when there are no worktrees', async () => {
    const result = await reopenCmux({ worktreeDir: WORKTREE_DIR, currentBranches: [], repoName: REPO })

    expect(result.opened).toEqual([])
    expect(openCmuxWorkspaceWithLayout).not.toHaveBeenCalled()
  })
})
