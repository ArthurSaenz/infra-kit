import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

// Import AFTER the mock is declared so the module picks up the mocked dep.
import { ConfigFileChangedError, migrateConfigFile } from 'src/lib/config-migrations'
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import { migrateConfigShapes, migrateLegacyConfig, migrateUserGlobalConfigFilename } from '../migrate-config'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    // Mirror the real signature: with a linked-worktree-free test repo the main
    // root IS the given toplevel, so echo the passed cwd back.
    getMainRepoRoot: vi.fn(async (cwd?: string) => {
      return cwd
    }),
  }
})

// Spy mode keeps the real implementations; the spies are the seams that let the stale-read race
// be injected and the cache reset be counted. A plain `vi.spyOn` on the namespace would not
// intercept the module's own named imports (memory: vispy-cannot-intercept-named-fs-imports).
vi.mock('src/lib/config-migrations', { spy: true })
vi.mock('src/lib/infra-kit-config', { spy: true })

const MAIN_YML = `envManagement:
  provider: doppler
  config:
    name: my-project
`

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

const withTmpRepo = async (fn: (tmp: string) => Promise<void>): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-init-migrate-test-'))

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(tmp))
  const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)

  try {
    await fn(tmp)
  } finally {
    homedirSpy.mockRestore()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

describe('migrateLegacyConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('converts a legacy infra-kit.yml to infra-kit.json and removes the .yml', async () => {
    await withTmpRepo(async (tmp) => {
      const ymlPath = path.join(tmp, 'infra-kit.yml')
      const jsonPath = path.join(tmp, 'infra-kit.json')

      writeFile(ymlPath, MAIN_YML)

      await migrateLegacyConfig()

      expect(fs.existsSync(ymlPath)).toBe(false)
      expect(fs.existsSync(jsonPath)).toBe(true)
      expect(JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))).toEqual({
        envManagement: { provider: 'doppler', config: { name: 'my-project' } },
      })
    })
  })

  it('is an idempotent no-op when the config is already JSON', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')
      const json = '{"environments":["dev"],"envManagement":{"provider":"doppler","config":{"name":"p"}}}'

      writeFile(jsonPath, json)

      await expect(migrateLegacyConfig()).resolves.toBeUndefined()

      expect(fs.readFileSync(jsonPath, 'utf-8')).toBe(json)
    })
  })

  it('warns and skips (does not throw or overwrite) when both .yml and .json exist', async () => {
    await withTmpRepo(async (tmp) => {
      const ymlPath = path.join(tmp, 'infra-kit.yml')
      const jsonPath = path.join(tmp, 'infra-kit.json')
      const existingJson = '{"environments":["keep"],"envManagement":{"provider":"doppler","config":{"name":"keep"}}}'

      writeFile(ymlPath, MAIN_YML)
      writeFile(jsonPath, existingJson)

      await expect(migrateLegacyConfig()).resolves.toBeUndefined()

      // Conflict left untouched — no overwrite, .yml preserved.
      expect(fs.existsSync(ymlPath)).toBe(true)
      expect(fs.readFileSync(jsonPath, 'utf-8')).toBe(existingJson)
    })
  })

  it('skips an invalid layer but still converts a valid sibling layer (non-fatal, per-layer)', async () => {
    await withTmpRepo(async (tmp) => {
      const mainYml = path.join(tmp, 'infra-kit.yml')
      const mainJson = path.join(tmp, 'infra-kit.json')
      // The user-global legacy YAML keeps the old `config.yml` name; its JSON
      // target is the renamed canonical `infra-kit.json`.
      const userGlobalYml = path.join(tmp, '.infra-kit', 'config.yml')
      const userGlobalJson = path.join(tmp, '.infra-kit', 'infra-kit.json')

      writeFile(mainYml, MAIN_YML)
      // Invalid override: `environments` is no longer a recognized key at all (strict schema).
      writeFile(userGlobalYml, 'environments: []\n')

      await expect(migrateLegacyConfig()).resolves.toBeUndefined()

      // Valid main layer converted…
      expect(fs.existsSync(mainYml)).toBe(false)
      expect(fs.existsSync(mainJson)).toBe(true)
      // …invalid user-global layer left as-is (no JSON written).
      expect(fs.existsSync(userGlobalYml)).toBe(true)
      expect(fs.existsSync(userGlobalJson)).toBe(false)
    })
  })

  it('warns and skips a malformed .yml without throwing', async () => {
    await withTmpRepo(async (tmp) => {
      const ymlPath = path.join(tmp, 'infra-kit.yml')
      const jsonPath = path.join(tmp, 'infra-kit.json')

      // Unparseable YAML (bad indentation / flow) — yaml.parse throws.
      writeFile(ymlPath, 'environments: [dev\n  : : :\n')

      await expect(migrateLegacyConfig()).resolves.toBeUndefined()

      expect(fs.existsSync(ymlPath)).toBe(true)
      expect(fs.existsSync(jsonPath)).toBe(false)
    })
  })

  it('converts all three merge-chain layers in one run', async () => {
    await withTmpRepo(async (tmp) => {
      const projectName = path.basename(tmp)
      const mainYml = path.join(tmp, 'infra-kit.yml')
      const userGlobalYml = path.join(tmp, '.infra-kit', 'config.yml')
      const userProjectYml = path.join(tmp, '.infra-kit', 'projects', projectName, 'infra-kit.yml')

      writeFile(mainYml, MAIN_YML)
      writeFile(userGlobalYml, 'worktrees:\n  openInOrca: true\n')
      writeFile(userProjectYml, 'worktrees:\n  openInGithubDesktop: false\n')

      await migrateLegacyConfig()

      // The user-global legacy `config.yml` migrates to the renamed canonical
      // `infra-kit.json`; main/userProject keep their `.yml`→`.json` sibling name.
      const pairs: [yml: string, json: string][] = [
        [mainYml, path.join(tmp, 'infra-kit.json')],
        [userGlobalYml, path.join(tmp, '.infra-kit', 'infra-kit.json')],
        [userProjectYml, path.join(tmp, '.infra-kit', 'projects', projectName, 'infra-kit.json')],
      ]

      for (const [yml, json] of pairs) {
        expect(fs.existsSync(yml)).toBe(false)
        expect(fs.existsSync(json)).toBe(true)
      }
    })
  })
})

describe('migrateConfigShapes', () => {
  let info: MockInstance<typeof logger.info>

  beforeEach(() => {
    vi.clearAllMocks()
    info = vi.spyOn(logger, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    info.mockRestore()
    vi.clearAllMocks()
  })

  const loggedLines = (): string[] => {
    return info.mock.calls.map(([line]) => {
      return String(line)
    })
  }

  it('rewrites infra-kit.json without the legacy ide.config.mode, preserves the rest, and logs the ✓ line', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      writeFile(
        jsonPath,
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: './ws.code-workspace' } },
        }),
      )

      await migrateConfigShapes()

      const result = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))

      expect(result.ide).toEqual({ provider: 'cursor', config: { workspaceConfigPath: './ws.code-workspace' } })
      expect(result.envManagement).toEqual({ provider: 'doppler', config: { name: 'p' } })
      expect(loggedLines()).toEqual([expect.stringMatching(/^✓ Migrated .*infra-kit\.json \(removed legacy "mode"\)$/)])
      expect(resetInfraKitConfigCache).toHaveBeenCalledTimes(1)
    })
  })

  it('migrates the user-global config layer too', async () => {
    await withTmpRepo(async (tmp) => {
      const userGlobalJson = path.join(tmp, '.infra-kit', 'infra-kit.json')

      writeFile(
        userGlobalJson,
        JSON.stringify({ ide: { provider: 'cursor', config: { mode: 'windows', workspaceConfigPath: 'ws' } } }),
      )

      await migrateConfigShapes()

      expect(JSON.parse(fs.readFileSync(userGlobalJson, 'utf-8')).ide).toEqual({
        provider: 'cursor',
        config: { workspaceConfigPath: 'ws' },
      })
    })
  })

  // The `zed` provider is retired and the strict schema refuses it, so `setup` is the only way a
  // machine whose user-global config still names it gets unstuck.
  it('drops a single retired zed ide entirely, preserving every other key', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      writeFile(
        jsonPath,
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: { provider: 'zed', config: {} },
          worktrees: { openInOrca: true },
        }),
      )

      await migrateConfigShapes()

      expect(JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))).toEqual({
        envManagement: { provider: 'doppler', config: { name: 'p' } },
        worktrees: { openInOrca: true },
      })
      expect(loggedLines()).toEqual([expect.stringContaining('(removed the retired "zed" provider)')])
    })
  })

  it('reaches the user-global layer even outside a project', async () => {
    await withTmpRepo(async (tmp) => {
      vi.mocked(getProjectRoot).mockRejectedValue(new Error('not a git repository'))
      const userGlobalJson = path.join(tmp, '.infra-kit', 'infra-kit.json')

      writeFile(userGlobalJson, JSON.stringify({ ide: { provider: 'zed', config: {} } }))

      await migrateConfigShapes()

      expect(JSON.parse(fs.readFileSync(userGlobalJson, 'utf-8'))).toEqual({})
    })
  })

  it('migrates the user-project config layer too', async () => {
    await withTmpRepo(async (tmp) => {
      const projectName = path.basename(tmp)
      const userProjectJson = path.join(tmp, '.infra-kit', 'projects', projectName, 'infra-kit.json')

      writeFile(
        userProjectJson,
        JSON.stringify({ ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws' } } }),
      )

      await migrateConfigShapes()

      expect(JSON.parse(fs.readFileSync(userProjectJson, 'utf-8')).ide).toEqual({
        provider: 'cursor',
        config: { workspaceConfigPath: 'ws' },
      })
    })
  })

  it('drops the retired environments key and names it in the ✓ line', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      writeFile(
        jsonPath,
        JSON.stringify({ environments: ['dev'], envManagement: { provider: 'doppler', config: { name: 'p' } } }),
      )

      await migrateConfigShapes()

      expect(JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))).toEqual({
        envManagement: { provider: 'doppler', config: { name: 'p' } },
      })
      expect(loggedLines()).toEqual([expect.stringContaining('(removed the retired "environments" key')])
    })
  })

  it('drops the retired devProxy key and names it in the ✓ line', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      writeFile(
        jsonPath,
        JSON.stringify({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          devProxy: { 'web/ui': 'https://web.localhost' },
        }),
      )

      await migrateConfigShapes()

      expect(JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))).toEqual({
        envManagement: { provider: 'doppler', config: { name: 'p' } },
      })
      expect(loggedLines()).toEqual([expect.stringContaining('(removed the retired "devProxy" key')])
    })
  })

  it('names every removed shape in one ✓ line, in registry order', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      writeFile(
        jsonPath,
        JSON.stringify({
          environments: ['dev'],
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: { provider: 'zed', config: { mode: 'workspace' } },
        }),
      )

      await migrateConfigShapes()

      expect(loggedLines()).toEqual([
        expect.stringMatching(
          /removed legacy "mode" and the retired "zed" provider and the retired "environments" key/,
        ),
      ])
    })
  })

  it('leaves an already-clean config byte-for-byte untouched, logs nothing, and keeps the cache (idempotent)', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')
      const json =
        '{"envManagement":{"provider":"doppler","config":{"name":"p"}},"ide":{"provider":"cursor","config":{"workspaceConfigPath":"ws"}}}'

      writeFile(jsonPath, json)

      await migrateConfigShapes()

      expect(fs.readFileSync(jsonPath, 'utf-8')).toBe(json)
      expect(info).not.toHaveBeenCalled()
      expect(resetInfraKitConfigCache).not.toHaveBeenCalled()
    })
  })

  it('warns and skips malformed JSON without throwing', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      writeFile(jsonPath, '{ not valid json ')

      await expect(migrateConfigShapes()).resolves.toBeUndefined()

      expect(fs.readFileSync(jsonPath, 'utf-8')).toBe('{ not valid json ')
      expect(loggedLines()).toEqual([expect.stringMatching(/^⚠ Skipped .*infra-kit\.json — /)])
      expect(resetInfraKitConfigCache).not.toHaveBeenCalled()
    })
  })

  // The helper's stale-read guard is internal to one call, so the race is injected at the seam:
  // the outcome under test is the line, the untouched file, and that the run carries on.
  it('warns "changed while migrating" and leaves the file when it moved on between read and write', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')
      const json = '{"environments":["dev"]}'

      writeFile(jsonPath, json)
      vi.mocked(migrateConfigFile).mockRejectedValueOnce(new ConfigFileChangedError(jsonPath))

      await expect(migrateConfigShapes()).resolves.toBeUndefined()

      expect(fs.readFileSync(jsonPath, 'utf-8')).toBe(json)
      expect(loggedLines()).toEqual([expect.stringMatching(/^⚠ Skipped .*infra-kit\.json — changed while migrating$/)])
      expect(resetInfraKitConfigCache).not.toHaveBeenCalled()
    })
  })

  it('skips a bad layer but still rewrites a clean sibling layer (non-fatal, per-layer)', async () => {
    await withTmpRepo(async (tmp) => {
      const mainJson = path.join(tmp, 'infra-kit.json')
      const userGlobalJson = path.join(tmp, '.infra-kit', 'infra-kit.json')

      writeFile(mainJson, '{ not valid json ')
      writeFile(userGlobalJson, JSON.stringify({ devProxy: {} }))

      await migrateConfigShapes()

      expect(JSON.parse(fs.readFileSync(userGlobalJson, 'utf-8'))).toEqual({})
      expect(resetInfraKitConfigCache).toHaveBeenCalledTimes(1)
    })
  })
})

describe('migrateUserGlobalConfigFilename', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  const userGlobalPaths = (tmp: string) => {
    const dir = path.join(tmp, '.infra-kit')

    return {
      legacyConfig: path.join(dir, 'config.json'),
      newConfig: path.join(dir, 'infra-kit.json'),
      legacyExample: path.join(dir, 'config.example.jsonc'),
      newExample: path.join(dir, 'infra-kit.example.jsonc'),
    }
  }

  it('renames config.json → infra-kit.json (and the example) preserving content', async () => {
    await withTmpRepo(async (tmp) => {
      const p = userGlobalPaths(tmp)
      const configBody = JSON.stringify({ worktrees: { openInOrca: true } })
      const exampleBody = '// example\n{}\n'

      writeFile(p.legacyConfig, configBody)
      writeFile(p.legacyExample, exampleBody)

      await migrateUserGlobalConfigFilename()

      expect(fs.existsSync(p.legacyConfig)).toBe(false)
      expect(fs.existsSync(p.legacyExample)).toBe(false)
      expect(fs.readFileSync(p.newConfig, 'utf-8')).toBe(configBody)
      expect(fs.readFileSync(p.newExample, 'utf-8')).toBe(exampleBody)
    })
  })

  it('is a no-op when there is no legacy config.json (idempotent)', async () => {
    await withTmpRepo(async (tmp) => {
      const p = userGlobalPaths(tmp)

      await expect(migrateUserGlobalConfigFilename()).resolves.toBeUndefined()

      expect(fs.existsSync(p.legacyConfig)).toBe(false)
      expect(fs.existsSync(p.newConfig)).toBe(false)
    })
  })

  it('never overwrites an existing infra-kit.json; leaves the stale config.json in place', async () => {
    await withTmpRepo(async (tmp) => {
      const p = userGlobalPaths(tmp)
      const legacyBody = JSON.stringify({ worktrees: { openInOrca: false } })
      const activeBody = JSON.stringify({ worktrees: { openInOrca: true } })

      writeFile(p.legacyConfig, legacyBody)
      writeFile(p.newConfig, activeBody)

      await migrateUserGlobalConfigFilename()

      // Active config untouched (NOT clobbered); legacy file preserved for the user.
      expect(fs.readFileSync(p.newConfig, 'utf-8')).toBe(activeBody)
      expect(fs.readFileSync(p.legacyConfig, 'utf-8')).toBe(legacyBody)
    })
  })

  it('migrates each file independently (example present, config absent)', async () => {
    await withTmpRepo(async (tmp) => {
      const p = userGlobalPaths(tmp)
      const exampleBody = '// example only\n{}\n'

      writeFile(p.legacyExample, exampleBody)

      await migrateUserGlobalConfigFilename()

      expect(fs.existsSync(p.legacyExample)).toBe(false)
      expect(fs.readFileSync(p.newExample, 'utf-8')).toBe(exampleBody)
      // No config.json existed → nothing created on that side.
      expect(fs.existsSync(p.newConfig)).toBe(false)
    })
  })

  it('yAML-legacy upgrade: migrateLegacyConfig + rename land config at infra-kit.json', async () => {
    await withTmpRepo(async (tmp) => {
      const p = userGlobalPaths(tmp)
      const legacyYml = path.join(tmp, '.infra-kit', 'config.yml')

      writeFile(legacyYml, 'worktrees:\n  openInOrca: true\n')

      // migrateLegacyConfig converts the pinned config.yml source → infra-kit.json;
      // the rename then has nothing left to do for the user-global config.
      await migrateLegacyConfig()
      await migrateUserGlobalConfigFilename()

      expect(fs.existsSync(legacyYml)).toBe(false)
      expect(fs.existsSync(p.legacyConfig)).toBe(false)
      expect(JSON.parse(fs.readFileSync(p.newConfig, 'utf-8')).worktrees.openInOrca).toBe(true)
    })
  })

  it('both-legacy files: YAML wins via migrateLegacyConfig, config.json is left untouched', async () => {
    await withTmpRepo(async (tmp) => {
      const p = userGlobalPaths(tmp)
      const legacyYml = path.join(tmp, '.infra-kit', 'config.yml')
      const jsonBody = JSON.stringify({ worktrees: { openInOrca: false } })

      writeFile(legacyYml, 'worktrees:\n  openInOrca: true\n')
      writeFile(p.legacyConfig, jsonBody)

      // init() order: migrateLegacyConfig (yml→infra-kit.json) then the rename.
      await migrateLegacyConfig()
      await migrateUserGlobalConfigFilename()

      // YAML content won at infra-kit.json; the rename's no-overwrite guard then
      // skipped config.json, leaving it untouched (no data loss).
      expect(JSON.parse(fs.readFileSync(p.newConfig, 'utf-8')).worktrees.openInOrca).toBe(true)
      expect(fs.readFileSync(p.legacyConfig, 'utf-8')).toBe(jsonBody)
    })
  })
})
