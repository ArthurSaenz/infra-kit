import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Import AFTER the mock is declared so the module picks up the mocked dep.
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'

import { migrateLegacyConfig, migrateUserGlobalConfigFilename, normalizeLegacyIdeStructures } from '../migrate-config'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
  }
})

const MAIN_YML = `environments:
  - dev
  - staging
envManagement:
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
        environments: ['dev', 'staging'],
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
      // Invalid override: environments present but empty (min(1) fails).
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
      writeFile(userGlobalYml, 'worktrees:\n  openInCmux: true\n')
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

describe('normalizeLegacyIdeStructures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('strips a legacy ide.config.mode from infra-kit.json (single provider) and preserves the rest', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      writeFile(
        jsonPath,
        JSON.stringify({
          environments: ['dev'],
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: './ws.code-workspace' } },
        }),
      )

      await normalizeLegacyIdeStructures()

      const result = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))

      expect(result.ide).toEqual({ provider: 'cursor', config: { workspaceConfigPath: './ws.code-workspace' } })
      // Everything else preserved verbatim.
      expect(result.environments).toEqual(['dev'])
      expect(result.envManagement).toEqual({ provider: 'doppler', config: { name: 'p' } })
    })
  })

  it('strips ide.config.mode from every entry of an array ide', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      writeFile(
        jsonPath,
        JSON.stringify({
          environments: ['dev'],
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          ide: [
            { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws' } },
            { provider: 'zed', config: { mode: 'windows' } },
          ],
        }),
      )

      await normalizeLegacyIdeStructures()

      const result = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))

      expect(result.ide).toEqual([
        { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
        { provider: 'zed', config: {} },
      ])
    })
  })

  it('normalizes the user-global config layer too', async () => {
    await withTmpRepo(async (tmp) => {
      const userGlobalJson = path.join(tmp, '.infra-kit', 'infra-kit.json')

      writeFile(userGlobalJson, JSON.stringify({ ide: { provider: 'zed', config: { mode: 'windows' } } }))

      await normalizeLegacyIdeStructures()

      expect(JSON.parse(fs.readFileSync(userGlobalJson, 'utf-8')).ide).toEqual({ provider: 'zed', config: {} })
    })
  })

  it('normalizes the user-project config layer too', async () => {
    await withTmpRepo(async (tmp) => {
      const projectName = path.basename(tmp)
      const userProjectJson = path.join(tmp, '.infra-kit', 'projects', projectName, 'infra-kit.json')

      writeFile(
        userProjectJson,
        JSON.stringify({ ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws' } } }),
      )

      await normalizeLegacyIdeStructures()

      expect(JSON.parse(fs.readFileSync(userProjectJson, 'utf-8')).ide).toEqual({
        provider: 'cursor',
        config: { workspaceConfigPath: 'ws' },
      })
    })
  })

  it('leaves an already-clean config byte-for-byte untouched (idempotent)', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')
      const json =
        '{"environments":["dev"],"envManagement":{"provider":"doppler","config":{"name":"p"}},"ide":{"provider":"zed","config":{}}}'

      writeFile(jsonPath, json)

      await normalizeLegacyIdeStructures()

      expect(fs.readFileSync(jsonPath, 'utf-8')).toBe(json)
    })
  })

  it('is a no-op when there is no ide config', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')
      const json = '{"environments":["dev"],"envManagement":{"provider":"doppler","config":{"name":"p"}}}'

      writeFile(jsonPath, json)

      await normalizeLegacyIdeStructures()

      expect(fs.readFileSync(jsonPath, 'utf-8')).toBe(json)
    })
  })

  it('warns and skips malformed JSON without throwing', async () => {
    await withTmpRepo(async (tmp) => {
      const jsonPath = path.join(tmp, 'infra-kit.json')

      writeFile(jsonPath, '{ not valid json ')

      await expect(normalizeLegacyIdeStructures()).resolves.toBeUndefined()

      expect(fs.readFileSync(jsonPath, 'utf-8')).toBe('{ not valid json ')
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
      const configBody = JSON.stringify({ worktrees: { openInCmux: true } })
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
      const legacyBody = JSON.stringify({ worktrees: { openInCmux: false } })
      const activeBody = JSON.stringify({ worktrees: { openInCmux: true } })

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

      writeFile(legacyYml, 'worktrees:\n  openInCmux: true\n')

      // migrateLegacyConfig converts the pinned config.yml source → infra-kit.json;
      // the rename then has nothing left to do for the user-global config.
      await migrateLegacyConfig()
      await migrateUserGlobalConfigFilename()

      expect(fs.existsSync(legacyYml)).toBe(false)
      expect(fs.existsSync(p.legacyConfig)).toBe(false)
      expect(JSON.parse(fs.readFileSync(p.newConfig, 'utf-8')).worktrees.openInCmux).toBe(true)
    })
  })

  it('both-legacy files: YAML wins via migrateLegacyConfig, config.json is left untouched', async () => {
    await withTmpRepo(async (tmp) => {
      const p = userGlobalPaths(tmp)
      const legacyYml = path.join(tmp, '.infra-kit', 'config.yml')
      const jsonBody = JSON.stringify({ worktrees: { openInCmux: false } })

      writeFile(legacyYml, 'worktrees:\n  openInCmux: true\n')
      writeFile(p.legacyConfig, jsonBody)

      // init() order: migrateLegacyConfig (yml→infra-kit.json) then the rename.
      await migrateLegacyConfig()
      await migrateUserGlobalConfigFilename()

      // YAML content won at infra-kit.json; the rename's no-overwrite guard then
      // skipped config.json, leaving it untouched (no data loss).
      expect(JSON.parse(fs.readFileSync(p.newConfig, 'utf-8')).worktrees.openInCmux).toBe(true)
      expect(fs.readFileSync(p.legacyConfig, 'utf-8')).toBe(jsonBody)
    })
  })
})
