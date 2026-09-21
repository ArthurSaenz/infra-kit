import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tryAutoMigrateLayer } from 'src/lib/config-migrations'
import { applyConfigMigrations } from 'src/lib/config-migrations/apply-config-migrations'
import { ConfigFileChangedError, writeMigratedConfigFile } from 'src/lib/config-migrations/migrate-config-file'
import { getMainRepoRoot, getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'

import { getInfraKitConfig, resetInfraKitConfigCache } from '../infra-kit-config'

/**
 * The loader's retry end to end: real files under a temp home + project root, the real registry,
 * the real writer. What is asserted is the loader's contract — which file gets rewritten, which
 * one is left alone, which error reaches the caller — not the helper's (that is
 * `config-migrations/__tests__/auto-migrate-layer.test.ts`).
 */

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    getMainRepoRoot: vi.fn(),
  }
})

// Spy mode on the leaf modules the helper imports by relative path — a spy on the barrel would
// not see the helper's own calls (memory: vispy-cannot-intercept-named-fs-imports). The barrel
// spy is for the loader's side of the seam: the outcome it was handed.
vi.mock('src/lib/config-migrations', { spy: true })
vi.mock('src/lib/config-migrations/apply-config-migrations', { spy: true })
vi.mock('src/lib/config-migrations/migrate-config-file', { spy: true })

const VALID = { envManagement: { provider: 'doppler', config: { name: 'p' } } }

const SETUP_HINT = 'A retired key on this branch'

let root: string
let mainPath: string
let userGlobalPath: string
let warnSpy: ReturnType<typeof vi.spyOn>
let debugSpy: ReturnType<typeof vi.spyOn>

const writeJson = async (filePath: string, value: Record<string, unknown>): Promise<string> => {
  const raw = `${JSON.stringify(value, null, 2)}\n`

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, raw)

  return raw
}

const readJson = async (filePath: string): Promise<unknown> => {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

const strictMessage = (label: string, filePath: string): RegExp => {
  return new RegExp(
    `^Invalid ${label.replaceAll('.', '\\.')} at ${filePath.replaceAll('.', '\\.')}: ✖ Unrecognized key`,
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  // The runner exports CI=true; every write case must start from "not CI".
  vi.stubEnv('CI', '')

  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-config-auto-migrate-'))
  mainPath = path.join(root, 'infra-kit.json')
  userGlobalPath = path.join(root, '.infra-kit', 'infra-kit.json')

  vi.mocked(getProjectRoot).mockResolvedValue(root)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(root))
  vi.mocked(getMainRepoRoot).mockResolvedValue(root)
  // Home = project root: the user-scope layers land under the temp dir, never the developer's.
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})

  resetInfraKitConfigCache()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  await fs.rm(root, { recursive: true, force: true })
})

describe('getInfraKitConfig — auto-migration of a refused layer', () => {
  it('layer 2 with `environments`: resolves, rewrites the file, warns once naming it', async () => {
    await writeJson(mainPath, VALID)
    await writeJson(userGlobalPath, { environments: ['dev'] })

    const cfg = await getInfraKitConfig()

    expect(cfg.envManagement.config.name).toBe('p')
    expect(await readJson(userGlobalPath)).toEqual({})
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/^Migrated ~\/\.infra-kit\/infra-kit\.json: removed /)
  })

  it('layer 1 with `envAutoLoad`: rewritten without the key, the line names it and the replacement', async () => {
    await writeJson(mainPath, { ...VALID, envAutoLoad: { enabled: true, config: 'dev' } })

    const cfg = await getInfraKitConfig()

    expect(cfg.envManagement.config.name).toBe('p')
    expect(await readJson(mainPath)).toEqual(VALID)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/removed the retired "envAutoLoad" key .*env-load -c <config>/)
  })

  it('the rewrite is exactly one cache miss: the next read parses the clean file without the registry', async () => {
    await writeJson(mainPath, VALID)
    await writeJson(userGlobalPath, { environments: ['dev'] })

    await getInfraKitConfig()

    expect(applyConfigMigrations).toHaveBeenCalledTimes(1)

    const second = await getInfraKitConfig()

    expect(second.envManagement.config.name).toBe('p')
    expect(applyConfigMigrations).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('layer 1 with `ide.config.mode`: rewritten, the line names the project file', async () => {
    await writeJson(mainPath, {
      ...VALID,
      ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: './ws.code-workspace' } },
    })

    const cfg = await getInfraKitConfig()

    expect(cfg.ide).toEqual({ provider: 'cursor', config: { workspaceConfigPath: './ws.code-workspace' } })
    expect(await readJson(mainPath)).toEqual({
      ...VALID,
      ide: { provider: 'cursor', config: { workspaceConfigPath: './ws.code-workspace' } },
    })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/^Migrated ~\/infra-kit\.json: removed legacy "mode"/)
  })

  it('a single retired `zed` entry: `ide` is dropped and the config resolves without one', async () => {
    await writeJson(mainPath, { ...VALID, ide: { provider: 'zed', config: {} } })

    const cfg = await getInfraKitConfig()

    expect(cfg.ide).toBeUndefined()
    expect(await readJson(mainPath)).toEqual(VALID)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('the layer handed to the merge is the schema output, defaults applied — not the raw migrated object', async () => {
    await writeJson(mainPath, { ...VALID, environments: ['dev'], mcp: { grafana: { command: 'g', env: ['TOKEN'] } } })

    const cfg = await getInfraKitConfig()

    expect(cfg.mcp?.grafana).toEqual({ command: 'g', env: ['TOKEN'], args: [], unset: [] })

    const outcome = await vi.mocked(tryAutoMigrateLayer).mock.results[0]?.value

    expect(outcome).toMatchObject({
      kind: 'migrated',
      data: { mcp: { grafana: { command: 'g', env: ['TOKEN'], args: [], unset: [] } } },
    })
    // The file gets the delete-only result, never the defaulted one.
    expect(await readJson(mainPath)).toEqual({ ...VALID, mcp: { grafana: { command: 'g', env: ['TOKEN'] } } })
  })
})

describe('getInfraKitConfig — the CI gate', () => {
  beforeEach(() => {
    vi.stubEnv('CI', 'true')
  })

  it("a dirty layer 1 is not rewritten: today's error plus the setup hint, file untouched", async () => {
    const raw = await writeJson(mainPath, { ...VALID, environments: ['dev'] })

    await expect(getInfraKitConfig()).rejects.toThrow(strictMessage('infra-kit.json', mainPath))
    await expect(getInfraKitConfig()).rejects.toThrow(SETUP_HINT)
    expect(await fs.readFile(mainPath, 'utf8')).toBe(raw)
    expect(writeMigratedConfigFile).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('a dirty layer 2 is still rewritten — only the tracked layer is gated', async () => {
    await writeJson(mainPath, VALID)
    await writeJson(userGlobalPath, { environments: ['dev'] })

    await getInfraKitConfig()

    expect(await readJson(userGlobalPath)).toEqual({})
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('a retired key next to a typo: the error names both keys and carries NO hint', async () => {
    const raw = await writeJson(mainPath, { ...VALID, environments: ['dev'], envManagment: {} })

    const error = await getInfraKitConfig().then(
      () => {
        throw new Error('expected the loader to reject')
      },
      (err: unknown) => {
        return err as Error
      },
    )

    expect(error.message).toMatch(strictMessage('infra-kit.json', mainPath))
    expect(error.message).toContain('"environments"')
    expect(error.message).toContain('"envManagment"')
    expect(error.message).not.toContain(SETUP_HINT)
    expect(await fs.readFile(mainPath, 'utf8')).toBe(raw)
    expect(writeMigratedConfigFile).not.toHaveBeenCalled()
  })
})

describe("getInfraKitConfig — no write, today's error", () => {
  it('a retired key next to a typo outside CI: rejected, nothing written', async () => {
    const raw = await writeJson(mainPath, { ...VALID, environments: ['dev'], envManagment: {} })

    await expect(getInfraKitConfig()).rejects.toThrow(strictMessage('infra-kit.json', mainPath))
    await expect(getInfraKitConfig()).rejects.not.toThrow(SETUP_HINT)
    expect(await fs.readFile(mainPath, 'utf8')).toBe(raw)
    expect(writeMigratedConfigFile).not.toHaveBeenCalled()
  })

  it('autoMigrate: "off" skips the registry entirely', async () => {
    const raw = await writeJson(mainPath, { ...VALID, environments: ['dev'] })

    await expect(getInfraKitConfig({ autoMigrate: 'off' })).rejects.toThrow(strictMessage('infra-kit.json', mainPath))
    expect(applyConfigMigrations).not.toHaveBeenCalled()
    expect(writeMigratedConfigFile).not.toHaveBeenCalled()
    expect(await fs.readFile(mainPath, 'utf8')).toBe(raw)
  })

  it('with autoMigrate off a lingering `envAutoLoad` is refused by name, so the user knows what to delete', async () => {
    const raw = await writeJson(mainPath, { ...VALID, envAutoLoad: { enabled: true, config: 'dev' } })

    await expect(getInfraKitConfig({ autoMigrate: 'off' })).rejects.toThrow(/"envAutoLoad"/)
    expect(await fs.readFile(mainPath, 'utf8')).toBe(raw)
  })

  it("a writer failure (EACCES) keeps today's error, the file untouched, and one debug line", async () => {
    vi.mocked(writeMigratedConfigFile).mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    )
    const raw = await writeJson(mainPath, { ...VALID, environments: ['dev'] })

    await expect(getInfraKitConfig()).rejects.toThrow(strictMessage('infra-kit.json', mainPath))
    expect(await fs.readFile(mainPath, 'utf8')).toBe(raw)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(debugSpy).toHaveBeenCalledTimes(1)
  })

  it('a file that moved on since the read (ConfigFileChangedError) is treated the same', async () => {
    vi.mocked(writeMigratedConfigFile).mockRejectedValueOnce(new ConfigFileChangedError(mainPath))
    const raw = await writeJson(mainPath, { ...VALID, environments: ['dev'] })

    await expect(getInfraKitConfig()).rejects.toThrow(strictMessage('infra-kit.json', mainPath))
    expect(await fs.readFile(mainPath, 'utf8')).toBe(raw)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(debugSpy).toHaveBeenCalledTimes(1)
  })
})

describe('getInfraKitConfig — refusals that fire before the parse are never retried', () => {
  it('`envTokens` keeps its revoke-first message, the registry is not consulted', async () => {
    await writeJson(mainPath, { ...VALID, environments: ['dev'], envTokens: { dev: 'dp.st.secret' } })

    await expect(getInfraKitConfig()).rejects.toThrow(/`envTokens` is not a config key/)
    expect(applyConfigMigrations).not.toHaveBeenCalled()
    expect(writeMigratedConfigFile).not.toHaveBeenCalled()
  })

  it('`mcp` in a user layer keeps its dedicated message, the registry is not consulted', async () => {
    await writeJson(mainPath, VALID)
    await writeJson(userGlobalPath, { environments: ['dev'], mcp: { grafana: { command: 'g', env: ['TOKEN'] } } })

    await expect(getInfraKitConfig()).rejects.toThrow(/"mcp" is not allowed in ~\/\.infra-kit\/infra-kit\.json/)
    expect(applyConfigMigrations).not.toHaveBeenCalled()
    expect(writeMigratedConfigFile).not.toHaveBeenCalled()
  })
})
