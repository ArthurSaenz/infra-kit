import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Imported AFTER the hoisted mock factory below, so the modules under test see the fakes.
import type { EnvAuthError } from 'src/lib/errors/env-auth-error'
import { isEnvAuthFailure } from 'src/lib/errors/env-auth-error'
import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig, resetInfraKitConfigCache } from 'src/lib/infra-kit-config'

import { getTokenStorePath, readTokenStore, removeToken, setToken, writeTokenStore } from '../env-tokens'
import type { TokenStore } from '../env-tokens'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    getMainRepoRoot: vi.fn(),
  }
})

const VALID_CONFIG = JSON.stringify({
  envManagement: { provider: 'doppler', config: { name: 'infra-kit' } },
})

let home: string
let repo: string
let repoName: string
let projectDir: string
let storePath: string

const storeFor = (envs: Record<string, string>): TokenStore => {
  return { version: 1, envs }
}

/**
 * Recreate the project dir exactly as the config bootstrap leaves it: created at the default umask,
 * i.e. 0755 and world-readable. The loose mode is the POINT of this fixture — it is the pre-existing
 * state `writeTokenStore` must tighten, so a "safe" 0700 here would make the perms test vacuous.
 */
const seedProjectDirAtDefaultUmask = (): void => {
  fs.mkdirSync(projectDir, { recursive: true })

  // eslint-disable-next-line sonarjs/file-permissions -- deliberately insecure: this IS the state under test
  fs.chmodSync(projectDir, 0o755)
}

/** Write raw bytes to the store path, under the loose dirs the config bootstrap already leaves. */
const preSeedStore = (contents: string): void => {
  seedProjectDirAtDefaultUmask()
  fs.writeFileSync(storePath, contents)
}

const modeOf = (target: string): string => {
  return (fs.statSync(target).mode & 0o777).toString(8)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'env-tokens-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'env-tokens-repo-'))
  repoName = path.basename(repo)
  projectDir = path.join(home, '.infra-kit', 'projects', repoName)
  storePath = path.join(projectDir, 'tokens.json')

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

  resetInfraKitConfigCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('getTokenStorePath', () => {
  it('is a sibling of the layer-3 infra-kit.json, keyed by the main repo root basename', async () => {
    await expect(getTokenStorePath()).resolves.toBe(storePath)
  })
})

describe('readTokenStore', () => {
  it('returns null — never throws — when the store does not exist', async () => {
    await expect(readTokenStore()).resolves.toBeNull()
  })

  it('parses a valid store', async () => {
    preSeedStore(JSON.stringify(storeFor({ dev: 'dp.st.dev.xxxx' })))

    await expect(readTokenStore()).resolves.toEqual(storeFor({ dev: 'dp.st.dev.xxxx' }))
  })

  it('throws an error naming the file when the JSON is corrupt', async () => {
    preSeedStore('garbage')

    await expect(readTokenStore()).rejects.toThrow(/Invalid JSON in the token store at .*tokens\.json/)
    await expect(readTokenStore()).rejects.toThrow(/env-token-set/)
  })

  /**
   * THE HAND-WRITTEN STORE — the shape a human actually types: no `version`, no repo-identity field.
   * The CLI must load it, which is the whole reason `version` is optional and `repoRoot` no longer
   * exists. Re-add a required key here and this is the test that reddens.
   */
  it('loads a hand-written store with no `version` key, defaulting it to 1', async () => {
    preSeedStore('{ "envs": { "dev": "dp.st.dev.handwritten" } }')

    await expect(readTokenStore()).resolves.toEqual({ version: 1, envs: { dev: 'dp.st.dev.handwritten' } })
  })

  it('throws an error naming the file when the shape does not match the schema', async () => {
    preSeedStore(JSON.stringify({ version: 2, envs: {} }))

    await expect(readTokenStore()).rejects.toThrow(/Invalid token store at .*tokens\.json/)
  })

  it('throws when an unknown key is present (the store schema is strict)', async () => {
    preSeedStore(JSON.stringify({ ...storeFor({ dev: 'dp.st.dev.x' }), envTokens: {} }))

    await expect(readTokenStore()).rejects.toThrow(/Invalid token store at/)
  })

  // The CLASS of every refusal above, not just its message. A broken store is the most DURABLE
  // env-auth failure there is — a 30s retry cannot heal it — but as a plain Error it is classified
  // TRANSIENT by env auto-load, expires with that backoff, and goes silent on the backgrounded
  // shell-startup spawn whose stderr is discarded. `env` is null: no ONE environment is at fault.
  it.each([
    ['corrupt JSON', 'garbage'],
    ['a schema mismatch', JSON.stringify({ version: 2, envs: {} })],
    ['a missing envs map', JSON.stringify({ version: 1 })],
  ])('refuses %s with an ENV-AUTH-class error carrying no single env', async (_label, contents) => {
    preSeedStore(contents)

    const error = await readTokenStore().catch((err: unknown) => {
      return err
    })

    expect(isEnvAuthFailure(error)).toBe(true)
    expect((error as EnvAuthError).env).toBeNull()
  })
})

describe('writeTokenStore', () => {
  it('writes the store 0600 and tightens the pre-existing 0755 parent dirs to 0700', async () => {
    // The config bootstrap seeds ~/.infra-kit/projects/<repo>/ at the default umask, so the dir is
    // already 0755 here. `mkdir`'s mode argument is a no-op for an existing dir — only the explicit
    // chmod tightens it, and that is exactly what must be asserted.
    seedProjectDirAtDefaultUmask()

    expect(modeOf(projectDir)).toBe('755')

    await writeTokenStore(storeFor({ dev: 'dp.st.dev.xxxx' }))

    expect(modeOf(storePath)).toBe('600')
    expect(modeOf(projectDir)).toBe('700')
    expect(modeOf(path.dirname(projectDir))).toBe('700')
    expect(modeOf(path.join(home, '.infra-kit'))).toBe('700')
  })

  it('creates the whole path 0700/0600 from nothing', async () => {
    await writeTokenStore(storeFor({ dev: 'dp.st.dev.xxxx' }))

    expect(modeOf(storePath)).toBe('600')
    expect(modeOf(projectDir)).toBe('700')
    expect(JSON.parse(fs.readFileSync(storePath, 'utf-8'))).toEqual(storeFor({ dev: 'dp.st.dev.xxxx' }))
  })

  /** The real-world state now that a store may be hand-written: a 0644 file this writer did not create. */
  it('tightens a pre-existing 0644 store it did not create', async () => {
    preSeedStore('{ "envs": { "dev": "dp.st.dev.handwritten" } }')

    // eslint-disable-next-line sonarjs/file-permissions -- deliberately insecure: this IS the state under test
    fs.chmodSync(storePath, 0o644)

    expect(modeOf(storePath)).toBe('644')

    await writeTokenStore(storeFor({ dev: 'dp.st.dev.xxxx' }))

    expect(modeOf(storePath)).toBe('600')
  })
})

describe('setToken / removeToken', () => {
  it('round-trips: set creates the store, a second set merges, remove drops just that key', async () => {
    await setToken('dev', 'dp.st.dev.xxxx')

    await expect(readTokenStore()).resolves.toEqual(storeFor({ dev: 'dp.st.dev.xxxx' }))

    await setToken('arthur', 'dp.st.arthur.yyyy')

    await expect(readTokenStore()).resolves.toEqual(storeFor({ dev: 'dp.st.dev.xxxx', arthur: 'dp.st.arthur.yyyy' }))

    await setToken('dev', 'dp.st.dev.zzzz')

    await expect(readTokenStore()).resolves.toEqual(storeFor({ dev: 'dp.st.dev.zzzz', arthur: 'dp.st.arthur.yyyy' }))

    await removeToken('dev')

    await expect(readTokenStore()).resolves.toEqual(storeFor({ arthur: 'dp.st.arthur.yyyy' }))

    expect(modeOf(storePath)).toBe('600')
  })

  it('removeToken is a no-op when the store is absent', async () => {
    await expect(removeToken('dev')).resolves.toBeUndefined()
    expect(fs.existsSync(storePath)).toBe(false)
  })

  /** A corrupt store is never silently flattened by a write — setToken reads it first, and that read throws. */
  it('setToken refuses to overwrite a corrupt store', async () => {
    preSeedStore('garbage')

    await expect(setToken('dev', 'dp.st.dev.mine')).rejects.toThrow(/Invalid JSON in the token store/)
    expect(fs.readFileSync(storePath, 'utf-8')).toBe('garbage')
  })

  /** The migration path for the owner's hand-written stores: set merges into them, it does not replace them. */
  it('setToken merges into a hand-written store (no version key) and stamps the version', async () => {
    preSeedStore('{ "envs": { "arthur": "dp.st.arthur.handwritten" } }')

    await setToken('dev', 'dp.st.dev.xxxx')

    await expect(readTokenStore()).resolves.toEqual(
      storeFor({ arthur: 'dp.st.arthur.handwritten', dev: 'dp.st.dev.xxxx' }),
    )
    expect(modeOf(storePath)).toBe('600')
  })
})

describe('an `envTokens` key in an infra-kit.json', () => {
  it('is refused with a REVOKE-first message naming the offending layer-3 file', async () => {
    fs.writeFileSync(path.join(repo, 'infra-kit.json'), VALID_CONFIG)
    fs.mkdirSync(projectDir, { recursive: true })

    const layerPath = path.join(projectDir, 'infra-kit.json')

    fs.writeFileSync(layerPath, JSON.stringify({ envTokens: { dev: 'dp.st.dev.leaked' } }))

    const error = await getInfraKitConfig().catch((err: Error) => {
      return err
    })

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('`envTokens` is not a config key')
    expect((error as Error).message).toContain('REVOKE the token in Doppler now')
    expect((error as Error).message).toContain(layerPath)
    expect((error as Error).message).toContain('infra-kit env-token-set <env>')
    expect((error as Error).message).toContain('tokens.json')
  })

  it('is refused in the committed project config too', async () => {
    fs.writeFileSync(
      path.join(repo, 'infra-kit.json'),
      JSON.stringify({ ...JSON.parse(VALID_CONFIG), envTokens: { dev: 'dp.st.dev.leaked' } }),
    )

    await expect(getInfraKitConfig()).rejects.toThrow(/`envTokens` is not a config key/)
  })

  it('leaves the generic unknown-key error alone for every OTHER key', async () => {
    fs.writeFileSync(path.join(repo, 'infra-kit.json'), JSON.stringify({ ...JSON.parse(VALID_CONFIG), notAKey: true }))

    const error = await getInfraKitConfig().catch((err: Error) => {
      return err
    })

    expect((error as Error).message).toContain('Invalid infra-kit.json at')
    expect((error as Error).message).not.toContain('REVOKE')
  })
})
