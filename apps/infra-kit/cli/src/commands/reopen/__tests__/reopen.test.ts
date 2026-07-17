import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  closeCmuxWorkspaceByCwd,
  createCmuxGroupFrom,
  findCmuxGroupRefByName,
  listCmuxWorkspacesByCwd,
  openCmuxWorkspaceWithLayout,
  realpathForCmuxCwd,
} from 'src/integrations/cmux'
import { openIdeWorkspace } from 'src/integrations/ide'
import { getMainRepoRoot, getProjectRoot, listWorktrees } from 'src/lib/git-utils'
import type { WorktreeEntry } from 'src/lib/git-utils'

import { reopenCurrentProject } from '../reopen'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getMainRepoRoot: vi.fn(),
    listWorktrees: vi.fn(),
  }
})

vi.mock('src/integrations/ide', async (importActual) => {
  const actual = await importActual<typeof import('src/integrations/ide')>()

  return {
    ...actual,
    openIdeWorkspace: vi.fn(),
  }
})

// Keep buildCmuxWorkspaceTitle real; mock the side-effects. realpathForCmuxCwd is
// stubbed to identity so cwd dedup/close is a literal string match in tests.
vi.mock('src/integrations/cmux', async (importActual) => {
  const actual = await importActual<typeof import('src/integrations/cmux')>()

  return {
    ...actual,
    listCmuxWorkspacesByCwd: vi.fn(),
    closeCmuxWorkspaceByCwd: vi.fn(),
    openCmuxWorkspaceWithLayout: vi.fn(),
    findCmuxGroupRefByName: vi.fn(),
    createCmuxGroupFrom: vi.fn(),
    realpathForCmuxCwd: vi.fn((cwd: string) => {
      return Promise.resolve(cwd)
    }),
  }
})

const ROOT = '/repos/hulyo'
const REPO = 'hulyo-monorepo'
const GROUP = 'workspace_group:1'

const entry = (over: Partial<WorktreeEntry> & Pick<WorktreeEntry, 'path' | 'branch'>): WorktreeEntry => {
  return { detached: false, bare: false, prunable: false, locked: false, ...over }
}

const mainEntry = entry({ path: ROOT, branch: 'dev' })
const releaseEntry = entry({ path: `${ROOT}-worktrees/release/v1.48.0`, branch: 'release/v1.48.0' })
const featureEntry = entry({ path: `${ROOT}-worktrees/feature/login`, branch: 'feature/login' })

describe('reopen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getProjectRoot).mockResolvedValue(ROOT)
    // repoName is basename(getMainRepoRoot) — return a path whose basename is REPO
    // (the stable main-repo name), decoupled from ROOT's leaf.
    vi.mocked(getMainRepoRoot).mockResolvedValue(`/repos/${REPO}`)
    vi.mocked(openIdeWorkspace).mockResolvedValue([])
    vi.mocked(listCmuxWorkspacesByCwd).mockResolvedValue(new Map())
    vi.mocked(openCmuxWorkspaceWithLayout).mockResolvedValue('workspace:9')
    vi.mocked(closeCmuxWorkspaceByCwd).mockResolvedValue(undefined)
    vi.mocked(findCmuxGroupRefByName).mockResolvedValue(GROUP)
    vi.mocked(createCmuxGroupFrom).mockResolvedValue(GROUP)
    vi.mocked(realpathForCmuxCwd).mockImplementation((cwd) => {
      return Promise.resolve(cwd)
    })
  })

  it('includes the MAIN checkout in the IDE open set even with 0 release/feature worktrees (AC#4)', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([mainEntry])

    const result = await reopenCurrentProject({})

    expect(openIdeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: ROOT,
        worktreePaths: [ROOT],
        currentBranches: [],
      }),
    )
    expect(result.structuredContent?.worktreePaths).toEqual([ROOT])
  })

  it('opens every active worktree into the repo group by default; Cursor branches stay release-only', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([mainEntry, releaseEntry, featureEntry])

    const result = await reopenCurrentProject({})

    // Zed gets the full active folder set (root + release + feature).
    expect(openIdeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePaths: [ROOT, releaseEntry.path, featureEntry.path],
        currentBranches: ['release/v1.48.0'],
      }),
    )
    // One cmux workspace opened per active worktree (none were already open), each into the group.
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(3)
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledWith(expect.objectContaining({ cwd: ROOT, group: GROUP }))
    expect(result.structuredContent?.cmuxOpened).toHaveLength(3)
  })

  it('--release-only restricts to release worktrees', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([mainEntry, releaseEntry, featureEntry])

    const result = await reopenCurrentProject({ releaseOnly: true })

    expect(openIdeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePaths: [releaseEntry.path],
        currentBranches: ['release/v1.48.0'],
      }),
    )
    expect(result.structuredContent?.releaseOnly).toBe(true)
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(1)
  })

  it('--force closes the open cmux workspace (by cwd) first, then reopens it', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([releaseEntry])
    vi.mocked(listCmuxWorkspacesByCwd).mockResolvedValue(new Map([[releaseEntry.path, 'workspace:5']]))

    const result = await reopenCurrentProject({ releaseOnly: true, force: true })

    expect(closeCmuxWorkspaceByCwd).toHaveBeenCalledWith(releaseEntry.path)
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(1)
    // Title is unprefixed now (the group header carries the repo name).
    expect(result.structuredContent?.cmuxClosed).toEqual(['1.48.0'])
  })

  it('--dry-run spawns nothing', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([mainEntry, releaseEntry])

    const result = await reopenCurrentProject({ dryRun: true })

    expect(openIdeWorkspace).not.toHaveBeenCalled()
    expect(openCmuxWorkspaceWithLayout).not.toHaveBeenCalled()
    expect(closeCmuxWorkspaceByCwd).not.toHaveBeenCalled()
    expect(result.structuredContent?.dryRun).toBe(true)
    expect(result.structuredContent?.worktreePaths).toEqual([ROOT, releaseEntry.path])
  })
})
