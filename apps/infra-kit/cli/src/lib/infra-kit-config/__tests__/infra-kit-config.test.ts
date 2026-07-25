import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Import AFTER the mock is declared so the module picks up the mocked dep.
import { getMainRepoRoot, getProjectRoot, getRepoName } from 'src/lib/git-utils'

import {
  getInfraKitConfig,
  getInfraKitConfigPaths,
  resetInfraKitConfigCache,
  resolveCmuxLayout,
  resolveConfiguredIdes,
} from '../infra-kit-config'
import type { InfraKitConfig } from '../infra-kit-config'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    getMainRepoRoot: vi.fn(),
  }
})

const VALID_JSON = JSON.stringify({
  envManagement: { provider: 'doppler', config: { name: 'my-project' } },
})

const ALTERNATE_JSON = JSON.stringify({
  envManagement: { provider: 'doppler', config: { name: 'other-project' } },
})

const withTmpRepo = async (fn: (tmp: string) => Promise<void>): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-config-test-'))

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(tmp))
  // No linked worktree in this fixture: the main repo root is the project root.
  vi.mocked(getMainRepoRoot).mockResolvedValue(tmp)
  // Point os.homedir() at the tmp dir so user-scope override layers
  // (~/.infra-kit/infra-kit.json, ~/.infra-kit/projects/<repo>/infra-kit.json)
  // can't leak the developer's real config into the test.
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

describe('getInfraKitConfig', () => {
  beforeEach(() => {
    resetInfraKitConfigCache()
  })

  afterEach(() => {
    resetInfraKitConfigCache()
    vi.clearAllMocks()
  })

  it('reads and validates a well-formed infra-kit.json', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.json'), VALID_JSON)

      const cfg = await getInfraKitConfig()

      expect(cfg.envManagement.config.name).toBe('my-project')
      expect(cfg.taskManager).toBeUndefined()
      expect(cfg.ide).toBeUndefined()
    })
  })

  it('rejects a config that still carries the removed `environments` key', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          environments: ['dev', 'staging'],
          envManagement: { provider: 'doppler', config: { name: 'p' } },
        }),
      )

      await expect(getInfraKitConfig()).rejects.toThrow(/Unrecognized key: "environments"/)
    })
  })

  it('accepts ide and taskManager when provided', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: { provider: 'cursor', config: { workspaceConfigPath: './ws.code-workspace' } },
          taskManager: { provider: 'jira', config: { baseUrl: 'https://example.atlassian.net', projectId: 123 } },
        }),
      )

      const cfg = await getInfraKitConfig()

      const ide = resolveConfiguredIdes(cfg)[0]

      if (!ide) {
        throw new Error('expected one configured ide')
      }

      expect(ide.provider).toBe('cursor')

      if (ide.provider === 'cursor') {
        expect(ide.config.workspaceConfigPath).toBe('./ws.code-workspace')
      }

      expect(cfg.taskManager?.provider).toBe('jira')
    })
  })

  it('accepts a zed ide provider with no workspaceConfigPath', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: { provider: 'zed', config: {} },
        }),
      )

      const cfg = await getInfraKitConfig()

      expect(resolveConfiguredIdes(cfg)[0]?.provider).toBe('zed')
    })
  })

  it('strips a legacy "mode" key (backward compat)', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: { provider: 'zed', config: { mode: 'windows' } },
        }),
      )

      const cfg = await getInfraKitConfig()

      const ide = resolveConfiguredIdes(cfg)[0]

      if (!ide) {
        throw new Error('expected one configured ide')
      }

      expect(ide.provider).toBe('zed')
      // The now-removed `mode` field is silently stripped, not rejected.
      expect(ide.config).not.toHaveProperty('mode')
    })
  })

  it('accepts an array of IDE providers (multi-editor)', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: [
            { provider: 'cursor', config: { workspaceConfigPath: './ws.code-workspace' } },
            { provider: 'zed', config: {} },
          ],
        }),
      )

      const cfg = await getInfraKitConfig()

      expect(
        resolveConfiguredIdes(cfg).map((ide) => {
          return ide.provider
        }),
      ).toEqual(['cursor', 'zed'])
    })
  })

  it('rejects an array with a duplicate provider at parse time', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: [
            { provider: 'cursor', config: { workspaceConfigPath: './a.code-workspace' } },
            { provider: 'cursor', config: { workspaceConfigPath: './b.code-workspace' } },
          ],
        }),
      )

      await expect(getInfraKitConfig()).rejects.toThrow(/each IDE provider may appear at most once/)
    })
  })

  it('rejects an empty IDE array', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: [],
        }),
      )

      await expect(getInfraKitConfig()).rejects.toThrow(/Invalid infra-kit\.json/)
    })
  })

  it('rejects an unknown ide provider', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: { provider: 'vscode', config: {} },
        }),
      )

      await expect(getInfraKitConfig()).rejects.toThrow(/Invalid infra-kit\.json/)
    })
  })

  it('accepts a worktrees prompt-defaults block', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          worktrees: { openInGithubDesktop: false, openInCmux: true },
        }),
      )

      const cfg = await getInfraKitConfig()

      expect(cfg.worktrees?.openInGithubDesktop).toBe(false)
      expect(cfg.worktrees?.openInCmux).toBe(true)
    })
  })

  it('lets the user-global config layer supply a worktrees block when the project omits it', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.json'), VALID_JSON)

      const userGlobalDir = path.join(tmp, '.infra-kit')

      fs.mkdirSync(userGlobalDir, { recursive: true })
      fs.writeFileSync(
        path.join(userGlobalDir, 'infra-kit.json'),
        JSON.stringify({ worktrees: { openInGithubDesktop: false, openInCmux: true } }),
      )

      const cfg = await getInfraKitConfig()

      expect(cfg.worktrees?.openInGithubDesktop).toBe(false)
      expect(cfg.worktrees?.openInCmux).toBe(true)
    })
  })

  it('treats an empty optional layer file as {}', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.json'), VALID_JSON)

      const userGlobalDir = path.join(tmp, '.infra-kit')

      fs.mkdirSync(userGlobalDir, { recursive: true })
      fs.writeFileSync(path.join(userGlobalDir, 'infra-kit.json'), '   \n')

      const cfg = await getInfraKitConfig()

      expect(cfg.envManagement.config.name).toBe('my-project')
    })
  })

  it('throws a descriptive error on malformed JSON', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.json'), '{ not valid json ')

      await expect(getInfraKitConfig()).rejects.toThrow(/Invalid JSON in infra-kit\.json/)
    })
  })

  it('rejects cursor without workspaceConfigPath', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: { provider: 'cursor', config: {} },
        }),
      )

      // Cursor requires workspaceConfigPath; with the single|array union the
      // inner message collapses to the union-level "Invalid input → at ide",
      // but the config is still rejected (which is what matters).
      await expect(getInfraKitConfig()).rejects.toThrow(/Invalid infra-kit\.json/)
    })
  })

  it('throws a plain not-found error when neither infra-kit.json nor a legacy .yml exists', async () => {
    await withTmpRepo(async () => {
      await expect(getInfraKitConfig()).rejects.toThrow(/not found/)
      // The plain branch (Step 4) — NOT the legacy-yml migration branch. Both now mention
      // `infra-kit init`, so the legacy-yml phrasing is the discriminator.
      await expect(getInfraKitConfig()).rejects.not.toThrow(/legacy infra-kit\.yml/)
    })
  })

  it('points at `infra-kit init` when a legacy infra-kit.yml exists but infra-kit.json does not', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.yml'), 'environments:\n  - dev\n')

      await expect(getInfraKitConfig()).rejects.toThrow(/infra-kit init/)
    })
  })

  it('ignores a non-loaded infra-kit.example.jsonc sibling', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.json'), VALID_JSON)
      // Content that would FAIL schema if it were ever merged into the config.
      fs.writeFileSync(path.join(tmp, 'infra-kit.example.jsonc'), '{\n  // comment\n  "environments": []\n}\n')

      const cfg = await getInfraKitConfig()

      expect(cfg.envManagement.config.name).toBe('my-project')
    })
  })

  it('ignores a non-loaded infra-kit.example.jsonc in the user-global layer', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.json'), VALID_JSON)

      const userGlobalDir = path.join(tmp, '.infra-kit')

      fs.mkdirSync(userGlobalDir, { recursive: true })
      // Schema-failing content that must never be merged.
      fs.writeFileSync(
        path.join(userGlobalDir, 'infra-kit.example.jsonc'),
        '{\n  // comment\n  "environments": []\n}\n',
      )

      const cfg = await getInfraKitConfig()

      expect(cfg.envManagement.config.name).toBe('my-project')
    })
  })

  it('throws when infra-kit.json is missing', async () => {
    await withTmpRepo(async () => {
      await expect(getInfraKitConfig()).rejects.toThrow(/not found/)
    })
  })

  it('throws a descriptive error on schema violations', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({ envManagement: { provider: 'doppler', config: { name: '' } } }),
      )

      await expect(getInfraKitConfig()).rejects.toThrow(/Invalid infra-kit\.json/)
    })
  })

  it('re-reads the file when mtime changes (long-running MCP scenario)', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      fs.writeFileSync(jsonPath, VALID_JSON)

      const first = await getInfraKitConfig()

      expect(first.envManagement.config.name).toBe('my-project')

      // Advance mtime past the previous stat to simulate an edit; write new content.
      const future = new Date(Date.now() + 2_000)

      fs.writeFileSync(jsonPath, ALTERNATE_JSON)
      fs.utimesSync(jsonPath, future, future)

      const second = await getInfraKitConfig()

      expect(second.envManagement.config.name).toBe('other-project')
    })
  })

  it('returns the cached value on repeated calls when mtime is unchanged', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      fs.writeFileSync(jsonPath, VALID_JSON)

      const a = await getInfraKitConfig()
      const b = await getInfraKitConfig()

      // Same object reference — no re-parse.
      expect(a).toBe(b)
    })
  })
})

describe('getInfraKitConfigPaths', () => {
  afterEach(() => {
    resetInfraKitConfigCache()
    vi.clearAllMocks()
  })

  it('keys the per-project override on the main repo root, not the worktree leaf', async () => {
    // Simulate a linked worktree: the checkout toplevel (getProjectRoot) is the
    // worktree's own path, while getMainRepoRoot resolves to the shared main repo.
    // The per-project override must converge on the MAIN repo name, so every
    // worktree of `hulyo` reads ~/.infra-kit/projects/hulyo/…, not …/feature-x/….
    const mainRoot = path.join(os.tmpdir(), 'hulyo')
    const worktreeRoot = path.join(os.tmpdir(), 'hulyo-worktrees', 'feature-x')
    const home = path.join(os.tmpdir(), 'fake-home')

    vi.mocked(getProjectRoot).mockResolvedValue(worktreeRoot)
    vi.mocked(getMainRepoRoot).mockResolvedValue(mainRoot)
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home)

    resetInfraKitConfigCache()

    try {
      const paths = await getInfraKitConfigPaths()

      // Namespace key follows the main repo, not the worktree leaf dir.
      expect(paths.projectName).toBe('hulyo')
      expect(paths.projectName).not.toBe('feature-x')
      expect(paths.userProject).toBe(path.join(home, '.infra-kit', 'projects', 'hulyo', 'infra-kit.json'))
      // Layer-1 committed config stays worktree-local (checked out per branch).
      expect(paths.main).toBe(path.join(worktreeRoot, 'infra-kit.json'))
      // Layer-2 user-global is home-scoped, unaffected by the worktree.
      expect(paths.userGlobal).toBe(path.join(home, '.infra-kit', 'infra-kit.json'))
    } finally {
      homedirSpy.mockRestore()
      resetInfraKitConfigCache()
    }
  })

  it('keys off the project root in a plain checkout (main === project root)', async () => {
    const root = path.join(os.tmpdir(), 'hulyo')
    const home = path.join(os.tmpdir(), 'fake-home')

    vi.mocked(getProjectRoot).mockResolvedValue(root)
    vi.mocked(getMainRepoRoot).mockResolvedValue(root)
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home)

    resetInfraKitConfigCache()

    try {
      const paths = await getInfraKitConfigPaths()

      expect(paths.projectName).toBe('hulyo')
      expect(paths.userProject).toBe(path.join(home, '.infra-kit', 'projects', 'hulyo', 'infra-kit.json'))
    } finally {
      homedirSpy.mockRestore()
      resetInfraKitConfigCache()
    }
  })
})

describe('getInfraKitConfigPaths memoization', () => {
  afterEach(() => {
    resetInfraKitConfigCache()
    vi.clearAllMocks()
  })

  it('spawns git at most once per process across repeated path resolutions', async () => {
    const root = path.join(os.tmpdir(), 'memo-repo')
    const home = path.join(os.tmpdir(), 'memo-home')

    vi.mocked(getProjectRoot).mockResolvedValue(root)
    vi.mocked(getMainRepoRoot).mockResolvedValue(root)
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home)

    resetInfraKitConfigCache()

    try {
      const first = await getInfraKitConfigPaths()
      const second = await getInfraKitConfigPaths()
      const third = await getInfraKitConfigPaths()

      // The memo's actual contract: two `git rev-parse` spawns for the whole process, not 2N.
      expect(getProjectRoot).toHaveBeenCalledTimes(1)
      expect(getMainRepoRoot).toHaveBeenCalledTimes(1)
      expect(second).toBe(first)
      expect(third).toBe(first)
    } finally {
      homedirSpy.mockRestore()
      resetInfraKitConfigCache()
    }
  })

  it('does not re-spawn git when getInfraKitConfig is called repeatedly', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.json'), VALID_JSON)

      await getInfraKitConfigPaths()
      await getInfraKitConfig()
      await getInfraKitConfig()

      // getInfraKitConfigPaths runs BEFORE the mtime cache, so without the memo this would be 3.
      expect(getProjectRoot).toHaveBeenCalledTimes(1)
      expect(getMainRepoRoot).toHaveBeenCalledTimes(1)
    })
  })

  it('rotates the memo when os.homedir() changes (homedir is part of the key)', async () => {
    const root = path.join(os.tmpdir(), 'memo-repo')
    const homeA = path.join(os.tmpdir(), 'memo-home-a')
    const homeB = path.join(os.tmpdir(), 'memo-home-b')

    vi.mocked(getProjectRoot).mockResolvedValue(root)
    vi.mocked(getMainRepoRoot).mockResolvedValue(root)
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeA)

    resetInfraKitConfigCache()

    try {
      const first = await getInfraKitConfigPaths()

      expect(first.userGlobal).toBe(path.join(homeA, '.infra-kit', 'infra-kit.json'))

      // A cwd-only key would serve homeA's (in the real suite: already-deleted) paths back here.
      homedirSpy.mockReturnValue(homeB)

      const second = await getInfraKitConfigPaths()

      expect(second.userGlobal).toBe(path.join(homeB, '.infra-kit', 'infra-kit.json'))
      expect(second.userProject).toBe(path.join(homeB, '.infra-kit', 'projects', 'memo-repo', 'infra-kit.json'))
      expect(getProjectRoot).toHaveBeenCalledTimes(2)
    } finally {
      homedirSpy.mockRestore()
      resetInfraKitConfigCache()
    }
  })

  it('never memoizes a rejection (outside a git repo stays a throw on every call)', async () => {
    const home = path.join(os.tmpdir(), 'memo-home')

    vi.mocked(getProjectRoot).mockRejectedValue(new Error('not a git repository'))
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home)

    resetInfraKitConfigCache()

    try {
      await expect(getInfraKitConfigPaths()).rejects.toThrow(/not a git repository/)
      await expect(getInfraKitConfigPaths()).rejects.toThrow(/not a git repository/)

      // Both calls really hit the primitive — the failure is recomputed, not cached.
      expect(getProjectRoot).toHaveBeenCalledTimes(2)
    } finally {
      homedirSpy.mockRestore()
      resetInfraKitConfigCache()
    }
  })

  it('resetInfraKitConfigCache() clears the path memo', async () => {
    const root = path.join(os.tmpdir(), 'memo-repo')
    const home = path.join(os.tmpdir(), 'memo-home')

    vi.mocked(getProjectRoot).mockResolvedValue(root)
    vi.mocked(getMainRepoRoot).mockResolvedValue(root)
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home)

    resetInfraKitConfigCache()

    try {
      await getInfraKitConfigPaths()

      expect(getProjectRoot).toHaveBeenCalledTimes(1)

      resetInfraKitConfigCache()

      await getInfraKitConfigPaths()

      expect(getProjectRoot).toHaveBeenCalledTimes(2)
      expect(getMainRepoRoot).toHaveBeenCalledTimes(2)
    } finally {
      homedirSpy.mockRestore()
      resetInfraKitConfigCache()
    }
  })
})

describe('merged-config cache key (cwd/homedir collision safety)', () => {
  afterEach(() => {
    resetInfraKitConfigCache()
    vi.clearAllMocks()
  })

  it('does not serve one repo config to another when their infra-kit.json mtimes collide', async () => {
    // Two distinct "repos" a long-lived process (the MCP server) might resolve configs for without a
    // restart. The mtime-only cache used to hit-test purely on mtimes, so an mtime collision between
    // two DIFFERENT repos would serve repo A's config back for repo B. Forcing the collision here
    // (rather than hoping for one) makes the bug reproducible on demand.
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-config-cache-key-a-'))
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-config-cache-key-b-'))
    const homeA = path.join(os.tmpdir(), 'infra-kit-config-cache-key-home-a')
    const homeB = path.join(os.tmpdir(), 'infra-kit-config-cache-key-home-b')

    const jsonA = path.join(rootA, 'infra-kit.json')
    const jsonB = path.join(rootB, 'infra-kit.json')

    fs.writeFileSync(jsonA, JSON.stringify({ envManagement: { provider: 'doppler', config: { name: 'repo-a' } } }))
    fs.writeFileSync(jsonB, JSON.stringify({ envManagement: { provider: 'doppler', config: { name: 'repo-b' } } }))

    // Force an mtime collision on both main config files — the exact condition the bug depends on.
    const collidingMtime = new Date('2024-01-01T00:00:00Z')

    fs.utimesSync(jsonA, collidingMtime, collidingMtime)
    fs.utimesSync(jsonB, collidingMtime, collidingMtime)

    const homedirSpy = vi.spyOn(os, 'homedir')

    resetInfraKitConfigCache()

    try {
      vi.mocked(getProjectRoot).mockResolvedValue(rootA)
      vi.mocked(getMainRepoRoot).mockResolvedValue(rootA)
      homedirSpy.mockReturnValue(homeA)

      const a = await getInfraKitConfig()

      expect(a.envManagement.config.name).toBe('repo-a')

      // Switch to repo B WITHOUT resetting the cache — this is the long-lived-process scenario.
      // mtimes are identical to repo A's; only cwd/homedir differ.
      vi.mocked(getProjectRoot).mockResolvedValue(rootB)
      vi.mocked(getMainRepoRoot).mockResolvedValue(rootB)
      homedirSpy.mockReturnValue(homeB)

      const b = await getInfraKitConfig()

      expect(b.envManagement.config.name).toBe('repo-b')
    } finally {
      homedirSpy.mockRestore()
      resetInfraKitConfigCache()
      fs.rmSync(rootA, { recursive: true, force: true })
      fs.rmSync(rootB, { recursive: true, force: true })
    }
  })
})

describe('resolveConfiguredIdes', () => {
  const base = {
    envManagement: { provider: 'doppler', config: { name: 'p' } },
  } as InfraKitConfig

  it('wraps a single ide object in an array', () => {
    const cfg = {
      ...base,
      ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
    } as InfraKitConfig

    expect(
      resolveConfiguredIdes(cfg).map((ide) => {
        return ide.provider
      }),
    ).toEqual(['cursor'])
  })

  it('returns an ide array as-is', () => {
    const cfg = {
      ...base,
      ide: [
        { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
        { provider: 'zed', config: {} },
      ],
    } as InfraKitConfig

    expect(
      resolveConfiguredIdes(cfg).map((ide) => {
        return ide.provider
      }),
    ).toEqual(['cursor', 'zed'])
  })

  it('returns an empty array when ide is unset', () => {
    expect(resolveConfiguredIdes(base)).toEqual([])
  })
})

describe('resolveCmuxLayout', () => {
  const base = {
    envManagement: { provider: 'doppler', config: { name: 'p' } },
  } as InfraKitConfig

  it('defaults to two-columns when worktrees.cmux is unset', () => {
    expect(resolveCmuxLayout(base)).toBe('two-columns')
  })

  it('defaults to two-columns when worktrees is set but cmux.layout is unset', () => {
    const cfg = { ...base, worktrees: { openInCmux: true } } as InfraKitConfig

    expect(resolveCmuxLayout(cfg)).toBe('two-columns')
  })

  it('returns the explicit two-columns layout', () => {
    const cfg = { ...base, worktrees: { cmux: { layout: 'two-columns' } } } as InfraKitConfig

    expect(resolveCmuxLayout(cfg)).toBe('two-columns')
  })

  it('returns the explicit three-pane layout', () => {
    const cfg = { ...base, worktrees: { cmux: { layout: 'three-pane' } } } as InfraKitConfig

    expect(resolveCmuxLayout(cfg)).toBe('three-pane')
  })
})

describe('worktrees.cmux schema validation', () => {
  it('accepts a valid cmux.layout and round-trips it through getInfraKitConfig', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          worktrees: { openInCmux: true, cmux: { layout: 'three-pane' } },
        }),
      )

      const cfg = await getInfraKitConfig()

      expect(resolveCmuxLayout(cfg)).toBe('three-pane')
    })
  })

  it('rejects an unknown cmux.layout value', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          worktrees: { cmux: { layout: 'four-pane' } },
        }),
      )

      await expect(getInfraKitConfig()).rejects.toThrow(/Invalid.*infra-kit/i)
    })
  })
})
