import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canonicalizeCmuxTitle,
  closeCmuxWorkspaceByTitle,
  listCmuxWorkspaceTitles,
  openCmuxWorkspaceWithLayout,
} from 'src/integrations/cmux'

import { closeCmux, reopenCmux } from '../reopen'

// Keep the pure helpers (buildCmuxWorkspaceTitle, canonicalizeCmuxTitle) real; only the three
// spawn/list side-effects are mocked.
vi.mock('src/integrations/cmux', async (importActual) => {
  const actual = await importActual<typeof import('src/integrations/cmux')>()

  return {
    ...actual,
    listCmuxWorkspaceTitles: vi.fn(),
    closeCmuxWorkspaceByTitle: vi.fn(),
    openCmuxWorkspaceWithLayout: vi.fn(),
  }
})

const TITLE_A = 'hulyo-monorepo 1.48.0'
const TITLE_B = 'hulyo-monorepo checkout-redesign'

const targets = [
  { title: TITLE_A, cwd: '/repos/hulyo-worktrees/release/v1.48.0' },
  { title: TITLE_B, cwd: '/repos/hulyo-worktrees/release/checkout-redesign' },
]

const canon = (title: string): string => {
  return canonicalizeCmuxTitle(title)
}

describe('reopenCmux — additive + deduped', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(openCmuxWorkspaceWithLayout).mockResolvedValue(undefined)
  })

  it('opens only the targets whose canonical title is not already open', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set([canon(TITLE_A)]))

    const result = await reopenCmux({ targets, force: false })

    expect(result.opened).toEqual([TITLE_B])
    expect(result.skipped).toEqual([TITLE_A])
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(1)
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledWith({ cwd: targets[1]!.cwd, title: TITLE_B })
  })

  it('is idempotent: a second run with everything already open opens 0 new workspaces', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set([canon(TITLE_A), canon(TITLE_B)]))

    const result = await reopenCmux({ targets, force: false })

    expect(result.opened).toEqual([])
    expect(result.skipped).toEqual([TITLE_A, TITLE_B])
    expect(openCmuxWorkspaceWithLayout).not.toHaveBeenCalled()
  })

  it('opens every target when none are open', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set())

    const result = await reopenCmux({ targets, force: false })

    expect(result.opened).toEqual([TITLE_A, TITLE_B])
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(2)
  })

  it('continues past a per-target failure and opens the rest', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set())
    vi.mocked(openCmuxWorkspaceWithLayout)
      .mockRejectedValueOnce(new Error('cmux boom'))
      .mockResolvedValueOnce(undefined)

    const result = await reopenCmux({ targets, force: false })

    expect(result.opened).toEqual([TITLE_B])
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(2)
  })
})

describe('reopenCmux — force', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(openCmuxWorkspaceWithLayout).mockResolvedValue(undefined)
  })

  it('bypasses dedup and force-opens every target without reading the open list', async () => {
    const result = await reopenCmux({ targets, force: true })

    expect(result.opened).toEqual([TITLE_A, TITLE_B])
    expect(result.skipped).toEqual([])
    expect(listCmuxWorkspaceTitles).not.toHaveBeenCalled()
    expect(openCmuxWorkspaceWithLayout).toHaveBeenCalledTimes(2)
  })
})

describe('closeCmux', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(closeCmuxWorkspaceByTitle).mockResolvedValue(undefined)
  })

  it('closes only the titles present in the open snapshot', async () => {
    vi.mocked(listCmuxWorkspaceTitles).mockResolvedValue(new Set([canon(TITLE_A)]))

    const closed = await closeCmux({ titles: [TITLE_A, TITLE_B] })

    expect(closed).toEqual([TITLE_A])
    expect(closeCmuxWorkspaceByTitle).toHaveBeenCalledTimes(1)
    expect(closeCmuxWorkspaceByTitle).toHaveBeenCalledWith(TITLE_A)
  })

  it('returns [] and skips the snapshot when there are no titles', async () => {
    const closed = await closeCmux({ titles: [] })

    expect(closed).toEqual([])
    expect(listCmuxWorkspaceTitles).not.toHaveBeenCalled()
    expect(closeCmuxWorkspaceByTitle).not.toHaveBeenCalled()
  })
})
