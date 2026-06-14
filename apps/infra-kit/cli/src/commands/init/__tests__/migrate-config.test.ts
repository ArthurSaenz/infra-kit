import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Import AFTER the mock is declared so the module picks up the mocked dep.
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'

import { migrateLegacyConfig } from '../migrate-config'

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
      const userGlobalYml = path.join(tmp, '.infra-kit', 'config.yml')
      const userGlobalJson = path.join(tmp, '.infra-kit', 'config.json')

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

      for (const yml of [mainYml, userGlobalYml, userProjectYml]) {
        expect(fs.existsSync(yml)).toBe(false)
        expect(fs.existsSync(yml.replace(/\.yml$/, '.json'))).toBe(true)
      }
    })
  })
})
