import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  closeCmuxWorkspaceByCwd,
  createCmuxGroupFrom,
  listCmuxWorkspacesByCwd,
  openCmuxWorkspaceWithLayout,
  realpathForCmuxCwd,
} from 'src/integrations/cmux'

import { closeCmux, reopenCmux } from '../reopen'

// Mock only the cmux side-effects; realpathForCmuxCwd is stubbed to identity so
// cwd comparison is a literal string match in tests.
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

const REPO = 'hulyo-monorepo'
const GROUP = 'workspace_group:1'
const CWD_A = '/repos/hulyo-worktrees/release/v1.48.0'
const CWD_B = '/repos/hulyo-worktrees/release/checkout-redesign'
const TITLE_A = '1.48.0'
const TITLE_B = 'checkout-redesign'

const targets = [
  { title: TITLE_A, cwd: CWD_A },
  { title: TITLE_B, cwd: CWD_B },
]

describe('reopenCmux — additive + deduped by cwd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(realpathForCmuxCwd).mockImplementation((cwd) => {
      return Promise.resolve(cwd)
    })
    vi.mocked(openCmuxWorkspaceWithLayout).mockResolvedValue('workspace:9')
    vi.mocked(createCmuxGroupFrom).mockResolvedValue(GROUP)
  })

  it('opens only the targets whose cwd is not already open, into the group', async () => {
    vi.mocked(listCmuxWorkspacesByCwd).mockResolvedValue(new Map([[CWD_A, 'workspace:5']]))

    const result = await reopenCmux({ targets, force: false, repoName: REPO, groupRef: GROUP })

    expect(result.opened).toEqual([TITLE_B])
    expect(result.skipped).toEqual([TITLE_A])
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(1)
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledWith({ cwd: CWD_B, title: TITLE_B, group: GROUP })
  })

  it('is idempotent: a second run with every cwd already open opens 0 new workspaces (incl. main)', async () => {
    // The group anchor sharing the main-repo cwd is excluded upstream by
    // listCmuxWorkspacesByCwd, so the map still resolves each real worktree cwd.
    vi.mocked(listCmuxWorkspacesByCwd).mockResolvedValue(
      new Map([
        [CWD_A, 'workspace:5'],
        [CWD_B, 'workspace:6'],
      ]),
    )

    const result = await reopenCmux({ targets, force: false, repoName: REPO, groupRef: GROUP })

    expect(result.opened).toEqual([])
    expect(result.skipped).toEqual([TITLE_A, TITLE_B])
    expect(openCmuxWorkspaceWithLayout).not.toHaveBeenCalled()
  })

  it('opens every target into the existing group when none are open', async () => {
    vi.mocked(listCmuxWorkspacesByCwd).mockResolvedValue(new Map())

    const result = await reopenCmux({ targets, force: false, repoName: REPO, groupRef: GROUP })

    expect(result.opened).toEqual([TITLE_A, TITLE_B])
    expect(openCmuxWorkspaceWithLayout).toHaveBeenNthCalledWith(1, { cwd: CWD_A, title: TITLE_A, group: GROUP })
    expect(createCmuxGroupFrom).not.toHaveBeenCalled()
  })

  it('bootstraps the group from the first opened workspace when none exists yet', async () => {
    vi.mocked(listCmuxWorkspacesByCwd).mockResolvedValue(new Map())
    vi.mocked(openCmuxWorkspaceWithLayout).mockResolvedValue('workspace:20')
    vi.mocked(createCmuxGroupFrom).mockResolvedValue(GROUP)

    const result = await reopenCmux({ targets, force: false, repoName: REPO, groupRef: null })

    expect(result.opened).toEqual([TITLE_A, TITLE_B])
    // First target opens ungrouped, then seeds the group (once) via --from.
    expect(openCmuxWorkspaceWithLayout).toHaveBeenNthCalledWith(1, { cwd: CWD_A, title: TITLE_A })
    expect(createCmuxGroupFrom).toHaveBeenCalledTimes(1)
    expect(createCmuxGroupFrom).toHaveBeenCalledWith(REPO, ['workspace:20'])
    // Second target opens straight into the freshly-created group.
    expect(openCmuxWorkspaceWithLayout).toHaveBeenNthCalledWith(2, { cwd: CWD_B, title: TITLE_B, group: GROUP })
  })

  it('continues past a per-target failure and opens the rest', async () => {
    vi.mocked(listCmuxWorkspacesByCwd).mockResolvedValue(new Map())
    vi.mocked(openCmuxWorkspaceWithLayout)
      .mockRejectedValueOnce(new Error('cmux boom'))
      .mockResolvedValueOnce('workspace:9')

    const result = await reopenCmux({ targets, force: false, repoName: REPO, groupRef: GROUP })

    expect(result.opened).toEqual([TITLE_B])
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(2)
  })
})

describe('reopenCmux — force', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(realpathForCmuxCwd).mockImplementation((cwd) => {
      return Promise.resolve(cwd)
    })
    vi.mocked(openCmuxWorkspaceWithLayout).mockResolvedValue('workspace:9')
  })

  it('bypasses dedup and force-opens every target without reading the open list', async () => {
    const result = await reopenCmux({ targets, force: true, repoName: REPO, groupRef: GROUP })

    expect(result.opened).toEqual([TITLE_A, TITLE_B])
    expect(result.skipped).toEqual([])
    expect(listCmuxWorkspacesByCwd).not.toHaveBeenCalled()
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(2)
  })
})

describe('closeCmux — by cwd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(realpathForCmuxCwd).mockImplementation((cwd) => {
      return Promise.resolve(cwd)
    })
    vi.mocked(closeCmuxWorkspaceByCwd).mockResolvedValue(undefined)
  })

  it('closes only the targets whose cwd is present in the open snapshot', async () => {
    vi.mocked(listCmuxWorkspacesByCwd).mockResolvedValue(new Map([[CWD_A, 'workspace:5']]))

    const closed = await closeCmux({ targets })

    expect(closed).toEqual([TITLE_A])
    expect(closeCmuxWorkspaceByCwd).toHaveBeenCalledTimes(1)
    expect(closeCmuxWorkspaceByCwd).toHaveBeenCalledWith(CWD_A)
  })

  it('returns [] and skips the snapshot when there are no targets', async () => {
    const closed = await closeCmux({ targets: [] })

    expect(closed).toEqual([])
    expect(listCmuxWorkspacesByCwd).not.toHaveBeenCalled()
    expect(closeCmuxWorkspaceByCwd).not.toHaveBeenCalled()
  })
})
