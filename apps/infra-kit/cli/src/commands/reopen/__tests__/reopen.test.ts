import { beforeEach, describe, expect, it, vi } from 'vitest'

import { openIdeWorkspace } from 'src/integrations/ide'
import { isOrcaWorktreeListed, listOrcaTerminals, openOrcaWorktreeTerminals, probeOrca } from 'src/integrations/orca'
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

// reopenCurrentProject now reads project config before its work (fail-honestly guard). Mock it so
// these behaviour tests exercise the reopen logic against a resolvable project, not config resolution.
vi.mock('src/lib/infra-kit-config', () => {
  return {
    getInfraKitConfig: vi.fn(),
    resolveOrcaLayout: vi.fn(() => {
      return 'two-columns'
    }),
  }
})

vi.mock('src/integrations/ide', async (importActual) => {
  const actual = await importActual<typeof import('src/integrations/ide')>()

  return {
    ...actual,
    openIdeWorkspace: vi.fn(),
  }
})

// Keep buildOrcaTerminalTitle / OrcaError / the poll real; mock the spawning verbs.
vi.mock('src/integrations/orca', async (importActual) => {
  const actual = await importActual<typeof import('src/integrations/orca')>()

  return {
    ...actual,
    probeOrca: vi.fn(),
    listOrcaTerminals: vi.fn(),
    openOrcaWorktreeTerminals: vi.fn(),
    isOrcaWorktreeListed: vi.fn(),
  }
})

const ROOT = '/repos/hulyo'
const REPO = 'hulyo-monorepo'

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
    vi.mocked(probeOrca).mockResolvedValue('ready')
    vi.mocked(listOrcaTerminals).mockResolvedValue({ terminals: [], truncated: false })
    vi.mocked(openOrcaWorktreeTerminals).mockResolvedValue({ handles: ['h0', 'h1'], layout: 'full' })
    vi.mocked(isOrcaWorktreeListed).mockResolvedValue(true)
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

  it('opens every active worktree in Orca by default, never with focus; Cursor branches stay release-only', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([mainEntry, releaseEntry, featureEntry])

    const result = await reopenCurrentProject({})

    // Zed gets the full active folder set (root + release + feature).
    expect(openIdeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePaths: [ROOT, releaseEntry.path, featureEntry.path],
        currentBranches: ['release/v1.48.0'],
      }),
    )
    // One Orca tab per active worktree (none were already open), none stealing the window.
    expect(openOrcaWorktreeTerminals).toHaveBeenCalledTimes(3)
    expect(openOrcaWorktreeTerminals).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: ROOT, title: 'dev', focus: false, layout: 'full', panes: 'two-columns' }),
    )
    expect(result.structuredContent?.orcaOpened).toEqual([
      { branch: 'dev', layout: 'full' },
      { branch: 'release/v1.48.0', layout: 'full' },
      { branch: 'feature/login', layout: 'full' },
    ])
    expect(result.structuredContent?.orcaSkipped).toEqual([])
    expect(result.structuredContent?.orcaHidden).toEqual([])
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
    expect(openOrcaWorktreeTerminals).toHaveBeenCalledTimes(1)
    expect(openOrcaWorktreeTerminals).toHaveBeenCalledWith(expect.objectContaining({ title: '1.48.0' }))
  })

  it('has no close path and no `force`: the result carries no closed-tabs field', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([releaseEntry])

    const result = await reopenCurrentProject({ releaseOnly: true })

    expect(Object.keys(result.structuredContent ?? {})).toEqual([
      'repo',
      'dryRun',
      'releaseOnly',
      'worktreePaths',
      'ideProviders',
      'orcaOpened',
      'orcaSkipped',
      'orcaHidden',
    ])
  })

  it('--dry-run spawns no terminal and partitions on the live terminal list', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([mainEntry, releaseEntry])
    vi.mocked(listOrcaTerminals).mockImplementation(async (cwd: string) => {
      return {
        terminals: cwd === ROOT ? [{ handle: 'h', title: 't', tabId: 'tab', connected: true, orphaned: false }] : [],
        truncated: false,
      }
    })

    const result = await reopenCurrentProject({ dryRun: true })

    expect(openIdeWorkspace).not.toHaveBeenCalled()
    expect(openOrcaWorktreeTerminals).not.toHaveBeenCalled()
    expect(result.structuredContent?.dryRun).toBe(true)
    expect(result.structuredContent?.worktreePaths).toEqual([ROOT, releaseEntry.path])
    expect(result.structuredContent?.orcaOpened).toEqual([{ branch: 'release/v1.48.0', layout: 'full' }])
    expect(result.structuredContent?.orcaSkipped).toEqual([{ branch: 'dev', reason: 'already_open' }])
    expect(result.structuredContent?.orcaHidden).toEqual([])
  })
})
