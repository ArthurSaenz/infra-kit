import { describe, expect, it, vi } from 'vitest'

import { createAtlasOpener } from 'src/dev/atlas/atlas-open'
import type { AtlasOpenDeps } from 'src/dev/atlas/atlas-open'

const makeDeps = (overrides: Partial<AtlasOpenDeps> = {}): AtlasOpenDeps => {
  return {
    platform: 'darwin',
    orcaWorktreeId: 'repo::/work/shop',
    revealFolder: vi.fn(async () => {}),
    openLogTerminal: vi.fn(async () => {
      return 'term_1'
    }),
    focusTerminal: vi.fn(async () => {
      return true
    }),
    ...overrides,
  }
}

const LOG = { kind: 'log', service: 'shop/ui', path: "/runs/42/it's.log" } as const

describe('createAtlasOpener', () => {
  it('reveals the run folder in Finder on macOS', async () => {
    const deps = makeDeps()

    expect(await createAtlasOpener(deps)({ kind: 'folder', path: '/runs/42' })).toBe('opened')
    expect(deps.revealFolder).toHaveBeenCalledWith('/runs/42')
  })

  it('leaves the run folder to the page on another platform', async () => {
    const deps = makeDeps({ platform: 'linux' })

    expect(await createAtlasOpener(deps)({ kind: 'folder', path: '/runs/42' })).toBe('unavailable')
    expect(deps.revealFolder).not.toHaveBeenCalled()
  })

  it("opens a log as an Orca tab in the runner's own worktree", async () => {
    const deps = makeDeps()

    expect(await createAtlasOpener(deps)(LOG)).toBe('opened')
    expect(deps.openLogTerminal).toHaveBeenCalledWith({
      worktreeId: 'repo::/work/shop',
      title: 'log: shop/ui',
      logPath: LOG.path,
    })
  })

  it('returns to the tab it opened instead of adding a second one', async () => {
    const deps = makeDeps()
    const open = createAtlasOpener(deps)

    await open(LOG)
    await open(LOG)

    expect(deps.openLogTerminal).toHaveBeenCalledTimes(1)
    expect(deps.focusTerminal).toHaveBeenCalledWith('term_1')
  })

  it('opens a new tab when the viewer closed the first', async () => {
    const deps = makeDeps({
      focusTerminal: vi.fn(async () => {
        return false
      }),
    })

    const open = createAtlasOpener(deps)

    await open(LOG)
    await open(LOG)

    expect(deps.openLogTerminal).toHaveBeenCalledTimes(2)
  })

  it('leaves a log to the page when the runner is not inside Orca', async () => {
    const deps = makeDeps({ orcaWorktreeId: undefined })

    expect(await createAtlasOpener(deps)(LOG)).toBe('unavailable')
    expect(deps.openLogTerminal).not.toHaveBeenCalled()
  })

  it('reads an Orca failure as unavailable, never as a crash', async () => {
    const deps = makeDeps({
      openLogTerminal: vi.fn(async () => {
        throw new Error('orca: runtime_error')
      }),
    })

    expect(await createAtlasOpener(deps)(LOG)).toBe('unavailable')
  })
})
