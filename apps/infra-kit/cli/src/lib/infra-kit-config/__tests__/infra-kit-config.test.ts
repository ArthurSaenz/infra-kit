import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Import AFTER the mock is declared so the module picks up the mocked dep.
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'

import { getInfraKitConfig, resetInfraKitConfigCache, resolveConfiguredIdes } from '../infra-kit-config'
import type { InfraKitConfig } from '../infra-kit-config'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
  }
})

const VALID_JSON = JSON.stringify({
  environments: ['dev', 'staging'],
  envManagement: { provider: 'doppler', config: { name: 'my-project' } },
})

const ALTERNATE_JSON = JSON.stringify({
  environments: ['dev'],
  envManagement: { provider: 'doppler', config: { name: 'other-project' } },
})

const withTmpRepo = async (fn: (tmp: string) => Promise<void>): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-config-test-'))

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(tmp))
  // Point os.homedir() at the tmp dir so user-scope override layers
  // (~/.infra-kit/config.json, ~/.infra-kit/projects/<repo>/infra-kit.json)
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
      expect(cfg.environments).toEqual(['dev', 'staging'])
      expect(cfg.taskManager).toBeUndefined()
      expect(cfg.ide).toBeUndefined()
    })
  })

  it('accepts ide and taskManager when provided', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.json'),
        JSON.stringify({
          environments: ['dev'],
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
          environments: ['dev'],
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
          environments: ['dev'],
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
          environments: ['dev'],
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
          environments: ['dev'],
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
          environments: ['dev'],
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
          environments: ['dev'],
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
          environments: ['dev'],
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
        path.join(userGlobalDir, 'config.json'),
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
      fs.writeFileSync(path.join(userGlobalDir, 'config.json'), '   \n')

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
          environments: ['dev'],
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
      await expect(getInfraKitConfig()).rejects.not.toThrow(/infra-kit init/)
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

      expect(cfg.environments).toEqual(['dev', 'staging'])
      expect(cfg.envManagement.config.name).toBe('my-project')
    })
  })

  it('ignores a non-loaded config.example.jsonc in the user-global layer', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.json'), VALID_JSON)

      const userGlobalDir = path.join(tmp, '.infra-kit')

      fs.mkdirSync(userGlobalDir, { recursive: true })
      // Schema-failing content that must never be merged.
      fs.writeFileSync(path.join(userGlobalDir, 'config.example.jsonc'), '{\n  // comment\n  "environments": []\n}\n')

      const cfg = await getInfraKitConfig()

      expect(cfg.environments).toEqual(['dev', 'staging'])
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
        JSON.stringify({ environments: [], envManagement: { provider: 'doppler', config: { name: '' } } }),
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
      expect(second.environments).toEqual(['dev'])
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

describe('resolveConfiguredIdes', () => {
  const base = {
    environments: ['dev'],
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
