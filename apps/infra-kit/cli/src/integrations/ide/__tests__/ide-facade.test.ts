import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addIdeWorktreeFolders } from '../add-ide-worktree-folders'
import { openIdeWorkspace } from '../open-ide-workspace'
import { removeIdeWorktreeFolders } from '../remove-ide-worktree-folders'

const config = vi.hoisted(() => {
  return { value: {} as { ide?: unknown } }
})

vi.mock('src/lib/infra-kit-config', () => {
  return {
    getInfraKitConfig: vi.fn(() => {
      return Promise.resolve(config.value)
    }),
    // Mirror the real normalizer (single → [ide], array → as-is, undefined → []).
    resolveConfiguredIdes: vi.fn((cfg: { ide?: unknown }) => {
      const ide = cfg.ide

      if (!ide) return []

      return Array.isArray(ide) ? ide : [ide]
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const cursor = vi.hoisted(() => {
  return {
    openCursorWorkspace: vi.fn(),
    addFoldersToCursorWorkspace: vi.fn(),
    removeFoldersFromCursorWorkspace: vi.fn(),
    launchCursor: vi.fn(),
    resolveCursorWorkspacePath: vi.fn((value: string) => {
      return `/abs/${value}`
    }),
  }
})

vi.mock('src/integrations/cursor', () => {
  return cursor
})

// Defense-in-depth: never let a test shell out to a real editor. Even if an
// editor spawn leaks back into a layer this suite exercises directly, `$` is a
// no-op here so `cursor <path>` can never open a real window during the run.
vi.mock('zx', () => {
  return { $: vi.fn() }
})

const zed = vi.hoisted(() => {
  return {
    openZedWorkspace: vi.fn(),
    addFoldersToZedWorkspace: vi.fn(),
    reuseZedWorkspace: vi.fn(),
  }
})

vi.mock('src/integrations/zed', () => {
  return zed
})

const cursorEntry = { provider: 'cursor', config: { workspaceConfigPath: 'ws' } }
const zedEntry = { provider: 'zed', config: {} }
const cursorConfig = { ide: cursorEntry }
const zedConfig = { ide: zedEntry }
const bothConfig = { ide: [cursorEntry, zedEntry] }
const unconfigured = { ide: undefined }

const baseOpenArgs = {
  projectRoot: '/repo',
  worktreeDir: '/repo.worktrees',
  currentBranches: ['release/v1.0.0'],
}

beforeEach(() => {
  vi.clearAllMocks()
  cursor.resolveCursorWorkspacePath.mockImplementation((value: string) => {
    return `/abs/${value}`
  })
})

describe('openIdeWorkspace', () => {
  it('routes to Cursor and tags the provider (passing the cursor config down)', async () => {
    config.value = cursorConfig
    cursor.openCursorWorkspace.mockResolvedValue({ ran: true, added: 1, removed: 0 })

    const outcomes = await openIdeWorkspace(baseOpenArgs)

    expect(cursor.openCursorWorkspace).toHaveBeenCalledWith({
      ...baseOpenArgs,
      cursorConfig: { workspaceConfigPath: 'ws' },
    })
    expect(zed.openZedWorkspace).not.toHaveBeenCalled()
    expect(outcomes).toEqual([{ ran: true, added: 1, removed: 0, provider: 'cursor' }])
  })

  it('routes to Zed and tags the provider', async () => {
    config.value = zedConfig
    zed.openZedWorkspace.mockResolvedValue({ ran: true, added: 2, removed: 0 })

    const outcomes = await openIdeWorkspace(baseOpenArgs)

    expect(zed.openZedWorkspace).toHaveBeenCalledWith(baseOpenArgs)
    expect(cursor.openCursorWorkspace).not.toHaveBeenCalled()
    expect(outcomes).toEqual([{ ran: true, added: 2, removed: 0, provider: 'zed' }])
  })

  it('opens BOTH editors when both are configured (one outcome per provider)', async () => {
    config.value = bothConfig
    cursor.openCursorWorkspace.mockResolvedValue({ ran: true, added: 1, removed: 0 })
    zed.openZedWorkspace.mockResolvedValue({ ran: true, added: 2, removed: 0 })

    const outcomes = await openIdeWorkspace(baseOpenArgs)

    expect(cursor.openCursorWorkspace).toHaveBeenCalledTimes(1)
    expect(zed.openZedWorkspace).toHaveBeenCalledTimes(1)
    expect(outcomes).toEqual([
      { ran: true, added: 1, removed: 0, provider: 'cursor' },
      { ran: true, added: 2, removed: 0, provider: 'zed' },
    ])
  })

  it('returns an empty array when no IDE is configured', async () => {
    config.value = unconfigured

    const outcomes = await openIdeWorkspace(baseOpenArgs)

    expect(cursor.openCursorWorkspace).not.toHaveBeenCalled()
    expect(zed.openZedWorkspace).not.toHaveBeenCalled()
    expect(outcomes).toEqual([])
  })
})

describe('addIdeWorktreeFolders', () => {
  const args = { projectRoot: '/repo', worktreeDir: '/repo.worktrees', branches: ['release/v1.0.0'] }

  it('adds to the Cursor workspace and reports skipped', async () => {
    config.value = cursorConfig
    cursor.addFoldersToCursorWorkspace.mockResolvedValue({ added: ['a'], skipped: ['b'] })

    const outcomes = await addIdeWorktreeFolders(args)

    expect(cursor.resolveCursorWorkspacePath).toHaveBeenCalledWith('ws', '/repo')
    expect(cursor.addFoldersToCursorWorkspace).toHaveBeenCalled()
    expect(outcomes).toEqual([{ ran: true, provider: 'cursor', added: 1, skipped: 1 }])
  })

  it('skips Cursor when workspaceConfigPath is missing', async () => {
    config.value = { ide: { provider: 'cursor', config: {} } }

    const outcomes = await addIdeWorktreeFolders(args)

    expect(cursor.addFoldersToCursorWorkspace).not.toHaveBeenCalled()
    expect(outcomes).toEqual([{ ran: false, provider: 'cursor', added: 0, skipped: 0 }])
  })

  it('adds to Zed via zed --add (skipped always 0)', async () => {
    config.value = zedConfig
    zed.addFoldersToZedWorkspace.mockResolvedValue({ added: ['a', 'b'] })

    const outcomes = await addIdeWorktreeFolders(args)

    expect(zed.addFoldersToZedWorkspace).toHaveBeenCalled()
    expect(outcomes).toEqual([{ ran: true, provider: 'zed', added: 2, skipped: 0 }])
  })

  it('adds to BOTH editors when both are configured', async () => {
    config.value = bothConfig
    cursor.addFoldersToCursorWorkspace.mockResolvedValue({ added: ['a'], skipped: [] })
    zed.addFoldersToZedWorkspace.mockResolvedValue({ added: ['a', 'b'] })

    const outcomes = await addIdeWorktreeFolders(args)

    expect(outcomes).toEqual([
      { ran: true, provider: 'cursor', added: 1, skipped: 0 },
      { ran: true, provider: 'zed', added: 2, skipped: 0 },
    ])
  })

  it('returns an empty array when no IDE is configured', async () => {
    config.value = unconfigured

    const outcomes = await addIdeWorktreeFolders(args)

    expect(outcomes).toEqual([])
  })
})

describe('removeIdeWorktreeFolders', () => {
  // currentWorktrees \ removedWorktrees => remaining = ['release/v1.1.0']
  const args = {
    projectRoot: '/repo',
    worktreeDir: '/repo.worktrees',
    currentWorktrees: ['release/v1.0.0', 'release/v1.1.0'],
    removedWorktrees: ['release/v1.0.0'],
    allowEditorRelaunch: false,
  }

  it('removes from the Cursor workspace', async () => {
    config.value = cursorConfig
    cursor.removeFoldersFromCursorWorkspace.mockResolvedValue({ removed: ['x'], notFound: [] })

    const outcomes = await removeIdeWorktreeFolders(args)

    expect(cursor.removeFoldersFromCursorWorkspace).toHaveBeenCalled()
    expect(outcomes).toEqual([{ provider: 'cursor', supported: true, removed: ['x'] }])
  })

  it('is a no-op for Cursor when workspaceConfigPath is missing', async () => {
    config.value = { ide: { provider: 'cursor', config: {} } }

    const outcomes = await removeIdeWorktreeFolders(args)

    expect(cursor.removeFoldersFromCursorWorkspace).not.toHaveBeenCalled()
    expect(outcomes).toEqual([{ provider: 'cursor', supported: true, removed: [] }])
  })

  it('does NOT relaunch Zed on the non-interactive path (allowEditorRelaunch: false)', async () => {
    config.value = zedConfig

    const outcomes = await removeIdeWorktreeFolders({ ...args, allowEditorRelaunch: false })

    expect(zed.reuseZedWorkspace).not.toHaveBeenCalled()
    expect(outcomes).toEqual([{ provider: 'zed', supported: true, removed: [] }])
  })

  it('relaunches Zed with the remaining set on the interactive path (allowEditorRelaunch: true)', async () => {
    config.value = zedConfig

    const outcomes = await removeIdeWorktreeFolders({ ...args, allowEditorRelaunch: true })

    expect(zed.reuseZedWorkspace).toHaveBeenCalledWith({
      projectRoot: '/repo',
      worktreeDir: '/repo.worktrees',
      remainingBranches: ['release/v1.1.0'],
    })
    expect(outcomes).toEqual([{ provider: 'zed', supported: true, removed: [] }])
  })

  it('reports Zed removed:[] when the relaunch swallowed a failure (ran:false), never throwing', async () => {
    config.value = zedConfig
    // reuseZedWorkspace is best-effort: it swallows launch failures internally and resolves
    // { ran: false } rather than rejecting, so the facade never sees a throw.
    zed.reuseZedWorkspace.mockResolvedValue({ ran: false })

    const outcomes = await removeIdeWorktreeFolders({ ...args, allowEditorRelaunch: true })

    expect(outcomes).toEqual([{ provider: 'zed', supported: true, removed: [] }])
  })

  it('removes from Cursor surgically AND relaunches Zed when both are configured (interactive)', async () => {
    config.value = bothConfig
    cursor.removeFoldersFromCursorWorkspace.mockResolvedValue({ removed: ['x'], notFound: [] })

    const outcomes = await removeIdeWorktreeFolders({ ...args, allowEditorRelaunch: true })

    expect(cursor.removeFoldersFromCursorWorkspace).toHaveBeenCalled()
    expect(zed.reuseZedWorkspace).toHaveBeenCalledWith({
      projectRoot: '/repo',
      worktreeDir: '/repo.worktrees',
      remainingBranches: ['release/v1.1.0'],
    })
    expect(outcomes).toEqual([
      { provider: 'cursor', supported: true, removed: ['x'] },
      { provider: 'zed', supported: true, removed: [] },
    ])
  })

  it('short-circuits to an empty array when nothing was removed (no config read needed)', async () => {
    config.value = zedConfig

    const outcomes = await removeIdeWorktreeFolders({ ...args, removedWorktrees: [] })

    expect(zed.reuseZedWorkspace).not.toHaveBeenCalled()
    expect(outcomes).toEqual([])
  })

  it('returns an empty array when no IDE is configured', async () => {
    config.value = unconfigured

    const outcomes = await removeIdeWorktreeFolders(args)

    expect(outcomes).toEqual([])
  })
})
