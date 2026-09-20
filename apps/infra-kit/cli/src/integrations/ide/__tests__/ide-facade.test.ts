import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addIdeWorktreeFolders } from '../add-ide-worktree-folders'
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

const cursorEntry = { provider: 'cursor', config: { workspaceConfigPath: 'ws' } }
const cursorConfig = { ide: cursorEntry }
const arrayConfig = { ide: [cursorEntry] }
const unconfigured = { ide: undefined }

beforeEach(() => {
  vi.clearAllMocks()
  cursor.resolveCursorWorkspacePath.mockImplementation((value: string) => {
    return `/abs/${value}`
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
    expect(cursor.launchCursor).toHaveBeenCalledWith('/abs/ws')
    expect(outcomes).toEqual([{ ran: true, provider: 'cursor', added: 1, skipped: 1 }])
  })

  it('skips Cursor when workspaceConfigPath is missing', async () => {
    config.value = { ide: { provider: 'cursor', config: {} } }

    const outcomes = await addIdeWorktreeFolders(args)

    expect(cursor.addFoldersToCursorWorkspace).not.toHaveBeenCalled()
    expect(outcomes).toEqual([{ ran: false, provider: 'cursor', added: 0, skipped: 0 }])
  })

  it('accepts the array form of the ide config', async () => {
    config.value = arrayConfig
    cursor.addFoldersToCursorWorkspace.mockResolvedValue({ added: ['a'], skipped: [] })

    const outcomes = await addIdeWorktreeFolders(args)

    expect(outcomes).toEqual([{ ran: true, provider: 'cursor', added: 1, skipped: 0 }])
  })

  it('returns an empty array when no IDE is configured', async () => {
    config.value = unconfigured

    const outcomes = await addIdeWorktreeFolders(args)

    expect(outcomes).toEqual([])
  })
})

describe('removeIdeWorktreeFolders', () => {
  const args = {
    projectRoot: '/repo',
    worktreeDir: '/repo.worktrees',
    removedWorktrees: ['release/v1.0.0'],
  }

  it('removes from the Cursor workspace', async () => {
    config.value = cursorConfig
    cursor.removeFoldersFromCursorWorkspace.mockResolvedValue({ removed: ['x'], notFound: [] })

    const outcomes = await removeIdeWorktreeFolders(args)

    expect(cursor.removeFoldersFromCursorWorkspace).toHaveBeenCalledWith({
      workspacePath: '/abs/ws',
      folderPaths: ['/repo.worktrees/release/v1.0.0'],
    })
    expect(outcomes).toEqual([{ provider: 'cursor', supported: true, removed: ['x'] }])
  })

  it('is a no-op for Cursor when workspaceConfigPath is missing', async () => {
    config.value = { ide: { provider: 'cursor', config: {} } }

    const outcomes = await removeIdeWorktreeFolders(args)

    expect(cursor.removeFoldersFromCursorWorkspace).not.toHaveBeenCalled()
    expect(outcomes).toEqual([{ provider: 'cursor', supported: true, removed: [] }])
  })

  it('reports removed:[] when the workspace write failed, never throwing', async () => {
    config.value = cursorConfig
    cursor.removeFoldersFromCursorWorkspace.mockRejectedValue(new Error('EACCES'))

    const outcomes = await removeIdeWorktreeFolders(args)

    expect(outcomes).toEqual([{ provider: 'cursor', supported: true, removed: [] }])
  })

  it('short-circuits to an empty array when nothing was removed (no config read needed)', async () => {
    config.value = cursorConfig

    const outcomes = await removeIdeWorktreeFolders({ ...args, removedWorktrees: [] })

    expect(cursor.removeFoldersFromCursorWorkspace).not.toHaveBeenCalled()
    expect(outcomes).toEqual([])
  })

  it('returns an empty array when no IDE is configured', async () => {
    config.value = unconfigured

    const outcomes = await removeIdeWorktreeFolders(args)

    expect(outcomes).toEqual([])
  })
})
