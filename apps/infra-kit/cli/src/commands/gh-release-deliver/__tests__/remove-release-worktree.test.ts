import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getCurrentWorktrees, getProjectRoot } from 'src/lib/git-utils'
import { removeWorktrees } from 'src/lib/worktrees'

import { removeReleaseWorktreeIfPresent } from '../gh-release-deliver'

/**
 * `removeWorktrees` now returns `{ removed, failed }`. The pre-merge worktree removal must check
 * MEMBERSHIP of the release branch in `removed` — a copy-pasted `removed.length === 0` would still
 * type-check and silently misreport under the new shape.
 */

const PROJECT_ROOT = '/workspace/project-root'
const RELEASE_BRANCH = 'release/v1.2.5'

vi.mock('src/lib/git-utils', () => {
  return {
    getCurrentWorktrees: vi.fn(),
    getProjectRoot: vi.fn(),
    deleteLocalBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
  }
})

vi.mock('src/lib/worktrees', () => {
  return { removeWorktrees: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/integrations/jira', () => {
  return { deliverJiraRelease: vi.fn(), loadJiraConfigOptional: vi.fn() }
})

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/prompts/release-picker', () => {
  return { pickReleaseBranch: vi.fn(), pickReleaseBranches: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getProjectRoot).mockResolvedValue(PROJECT_ROOT)
  vi.mocked(getCurrentWorktrees).mockResolvedValue([RELEASE_BRANCH])
})

describe('removeReleaseWorktreeIfPresent', () => {
  it('does nothing when the release branch has no worktree', async () => {
    vi.mocked(getCurrentWorktrees).mockResolvedValue([])

    await removeReleaseWorktreeIfPresent(RELEASE_BRANCH)

    expect(removeWorktrees).not.toHaveBeenCalled()
  })

  it('passes projectRoot and resolves when the release worktree was removed', async () => {
    vi.mocked(removeWorktrees).mockResolvedValue({ removed: [RELEASE_BRANCH], failed: [] })

    await expect(removeReleaseWorktreeIfPresent(RELEASE_BRANCH)).resolves.toBeUndefined()

    expect(vi.mocked(removeWorktrees).mock.calls[0]?.[0]).toMatchObject({
      branches: [RELEASE_BRANCH],
      projectRoot: PROJECT_ROOT,
    })
  })

  it('throws with the failure reason when the release worktree was not removed', async () => {
    vi.mocked(removeWorktrees).mockResolvedValue({
      removed: [],
      failed: [{ branch: RELEASE_BRANCH, reason: 'fatal: contains modified or untracked files' }],
    })

    await expect(removeReleaseWorktreeIfPresent(RELEASE_BRANCH)).rejects.toThrow(/modified or untracked/)
  })
})
