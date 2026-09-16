import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Import AFTER the mock is declared so the module picks up the mocked dep.
import { getMainRepoRoot, getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'

import { getInfraKitConfig, infraKitConfigObject, resetInfraKitConfigCache } from '../infra-kit-config'
import { renameCmuxKeys, stripLegacyCmuxKeys } from '../legacy-cmux-keys'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    getMainRepoRoot: vi.fn(),
  }
})

const ENV = { envManagement: { provider: 'doppler', config: { name: 'p' } } }

const withTmpRepo = async (fn: (tmp: string) => Promise<void>): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-legacy-cmux-test-'))

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(tmp))
  vi.mocked(getMainRepoRoot).mockResolvedValue(tmp)
  const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)

  resetInfraKitConfigCache()

  try {
    await fn(tmp)
  } finally {
    homedirSpy.mockRestore()
    resetInfraKitConfigCache()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

describe('renameCmuxKeys', () => {
  it.each([
    {
      name: 'worktrees.openInCmux → worktrees.openInOrca',
      input: { worktrees: { openInCmux: true } },
      expected: { worktrees: { openInOrca: true } },
    },
    {
      name: 'worktrees.cmux → worktrees.orca',
      input: { worktrees: { cmux: { layout: 'three-pane' } } },
      expected: { worktrees: { orca: { layout: 'three-pane' } } },
    },
    {
      name: 'devServersPresets.<k>.cmux → devServersPresets.<k>.orca',
      input: { devServersPresets: { backend: { apps: {}, cmux: true }, ui: { cmux: false } } },
      expected: { devServersPresets: { backend: { apps: {}, orca: true }, ui: { orca: false } } },
    },
    {
      name: 'all three at once, other keys untouched',
      input: {
        ...ENV,
        worktrees: { openInGithubDesktop: false, openInCmux: true, cmux: { layout: 'two-columns' } },
        devServersPresets: { backend: { cmux: true }, plain: { apps: {} } },
      },
      expected: {
        ...ENV,
        worktrees: { openInGithubDesktop: false, openInOrca: true, orca: { layout: 'two-columns' } },
        devServersPresets: { backend: { orca: true }, plain: { apps: {} } },
      },
    },
  ])('renames $name', ({ input, expected }) => {
    const { changed, result } = renameCmuxKeys(input)

    expect(changed).toBe(true)
    expect(result).toEqual(expected)
  })

  it('preserves key order so the rewritten file diffs as a rename, not a reshuffle', () => {
    const { result } = renameCmuxKeys({ worktrees: { openInGithubDesktop: false, openInCmux: true, cmux: {} } })

    expect(Object.keys((result as { worktrees: object }).worktrees)).toEqual([
      'openInGithubDesktop',
      'openInOrca',
      'orca',
    ])
  })

  it('lets an existing orca key win and drops the legacy one when both are present', () => {
    const { changed, result } = renameCmuxKeys({
      worktrees: {
        openInCmux: false,
        openInOrca: true,
        cmux: { layout: 'three-pane' },
        orca: { layout: 'two-columns' },
      },
      devServersPresets: { backend: { cmux: false, orca: true } },
    })

    expect(changed).toBe(true)
    expect(result).toEqual({
      worktrees: { openInOrca: true, orca: { layout: 'two-columns' } },
      devServersPresets: { backend: { orca: true } },
    })
  })

  it('is idempotent — a second pass over the result is a no-op', () => {
    const first = renameCmuxKeys({ worktrees: { openInCmux: true }, devServersPresets: { b: { cmux: true } } })
    const second = renameCmuxKeys(first.result)

    expect(second.changed).toBe(false)
    expect(second.result).toBe(first.result)
  })

  it.each([
    { name: 'already-migrated config', input: { ...ENV, worktrees: { openInOrca: true, orca: {} } } },
    { name: 'no worktrees / presets', input: ENV },
    { name: 'presets without the flag', input: { devServersPresets: { b: { apps: {} } } } },
    { name: 'non-object worktrees', input: { worktrees: 'nope' } },
    { name: 'non-object top level', input: ['openInCmux'] },
    { name: 'null', input: null },
  ])('returns the same reference unchanged for $name', ({ input }) => {
    const { changed, result } = renameCmuxKeys(input)

    expect(changed).toBe(false)
    expect(result).toBe(input)
  })
})

describe('stripLegacyCmuxKeys', () => {
  it('removes exactly the three legacy paths and reports them dotted', () => {
    const { stripped, result } = stripLegacyCmuxKeys({
      ...ENV,
      worktrees: { openInGithubDesktop: false, openInCmux: true, cmux: { layout: 'two-columns' } },
      devServersPresets: { backend: { apps: {}, cmux: true }, plain: { apps: {} } },
    })

    expect(stripped).toEqual(['worktrees.openInCmux', 'worktrees.cmux', 'devServersPresets.backend.cmux'])
    expect(result).toEqual({
      ...ENV,
      worktrees: { openInGithubDesktop: false },
      devServersPresets: { backend: { apps: {} }, plain: { apps: {} } },
    })
  })

  it('does NOT strip the orca keys (they are the live vocabulary)', () => {
    const input = {
      worktrees: { openInOrca: true, orca: { layout: 'three-pane' } },
      devServersPresets: { b: { orca: true } },
    }
    const { stripped, result } = stripLegacyCmuxKeys(input)

    expect(stripped).toEqual([])
    expect(result).toBe(input)
  })

  it.each([
    { name: 'clean config', input: ENV },
    { name: 'non-object top level', input: 'text' },
    { name: 'null', input: null },
  ])('returns the same reference with nothing stripped for $name', ({ input }) => {
    const { stripped, result } = stripLegacyCmuxKeys(input)

    expect(stripped).toEqual([])
    expect(result).toBe(input)
  })
})

describe('schema (strip bypassed)', () => {
  it('accepts the orca keys', () => {
    const parsed = infraKitConfigObject.safeParse({
      ...ENV,
      worktrees: { openInOrca: true, orca: { layout: 'three-pane' } },
      devServersPresets: { backend: { apps: { 'client/api': {} }, orca: true } },
    })

    expect(parsed.success).toBe(true)
  })

  it.each([
    { name: 'worktrees.openInCmux', input: { ...ENV, worktrees: { openInCmux: true } } },
    { name: 'worktrees.cmux', input: { ...ENV, worktrees: { cmux: { layout: 'two-columns' } } } },
    { name: 'devServersPresets.<k>.cmux', input: { ...ENV, devServersPresets: { b: { cmux: true } } } },
  ])('rejects the legacy $name as an unrecognized key', ({ input }) => {
    const parsed = infraKitConfigObject.safeParse(input)

    expect(parsed.success).toBe(false)
  })
})

describe('getInfraKitConfig with legacy cmux keys on disk', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.clearAllMocks()
  })

  it('parses OK, drops the legacy keys, and warns exactly once per file per process', async () => {
    await withTmpRepo(async (tmp) => {
      const file = path.join(tmp, 'infra-kit.json')

      fs.writeFileSync(file, JSON.stringify({ ...ENV, worktrees: { openInGithubDesktop: false, openInCmux: true } }))

      const cfg = await getInfraKitConfig()

      expect(cfg.worktrees).toEqual({ openInGithubDesktop: false })
      expect(warnSpy).toHaveBeenCalledTimes(1)

      const message = String(warnSpy.mock.calls[0]?.[0])

      expect(message).toContain('worktrees.openInCmux')
      expect(message).toContain('infra-kit.json')
      expect(message).toContain('infra-kit setup')

      // Nothing is written at read time — the file is `setup`'s to rewrite.
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
        ...ENV,
        worktrees: { openInGithubDesktop: false, openInCmux: true },
      })

      // A second read that actually re-reads the layer (cache dropped) stays silent.
      resetInfraKitConfigCache()
      await getInfraKitConfig()

      expect(warnSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('strips the legacy keys in an override layer too', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.json'), JSON.stringify(ENV))
      fs.mkdirSync(path.join(tmp, '.infra-kit'), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, '.infra-kit', 'infra-kit.json'),
        JSON.stringify({ worktrees: { openInCmux: true, cmux: { layout: 'three-pane' }, openInGithubDesktop: true } }),
      )

      const cfg = await getInfraKitConfig()

      expect(cfg.worktrees).toEqual({ openInGithubDesktop: true })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('worktrees.openInCmux, worktrees.cmux')
    })
  })
})
