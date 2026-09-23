import type fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedEnvToken } from 'src/integrations/doppler'
import type { TokenStore } from 'src/lib/env-tokens'
import type { InfraKitConfig } from 'src/lib/infra-kit-config'
import { listProjectEnvNames } from 'src/lib/project-envs'

import type { DoctorConfig, EnvTokenCheckDeps } from '../doctor'
import { checkEnvTokensConfigured, checkTokenStorePerms, checkTokenStorePresent } from '../doctor'

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

// `checkEnvTokensConfigured` sources its env universe from `listProjectEnvNames` (the
// workflow/token-store union), not from a config field anymore — mocked here so this
// file stays about the token-status verdicts, not workflow-YAML fixtures.
vi.mock('src/lib/project-envs', () => {
  return { listProjectEnvNames: vi.fn() }
})

beforeEach(() => {
  vi.mocked(listProjectEnvNames).mockReset()
})

/**
 * The literal every assertion in the leak test hunts for. A doctor line is printed to a terminal,
 * pasted into bug reports and returned over MCP — a token in one is a credential disclosure, so the
 * matrix below renders EVERY branch of all the checks and greps the lot.
 */
const TOKEN = 'dp.st.dev.SUPER-SECRET-DO-NOT-PRINT'

/** The merged config as doctor already read it (see `readDoctorConfig`). */
const configured = (): DoctorConfig => {
  return {
    config: { envManagement: { provider: 'doppler', config: { name: 'api' } } } as unknown as InfraKitConfig,
    error: null,
  }
}

/** How each env's token resolves. A missing entry = no token (the resolver throws). */
type TokenMap = Record<string, ResolvedEnvToken['source']>

const depsFor = (tokens: TokenMap): EnvTokenCheckDeps => {
  // The store is DERIVED from the same map the resolver answers from, never hardcoded: since
  // `checkEnvTokensConfigured` defers an empty store to `tokens.json present`, a fixture whose store
  // disagreed with its resolver would describe an impossible machine — a token resolving from a
  // `store` source with no store on disk — and would silently exercise the wrong branch.
  const stored = Object.entries(tokens).filter(([, source]) => {
    return source === 'store'
  })

  return {
    readStore: async () => {
      if (stored.length === 0) return null

      return {
        version: 1,
        envs: Object.fromEntries(
          stored.map(([env]) => {
            return [env, TOKEN]
          }),
        ),
      }
    },
    resolveToken: async (env: string) => {
      const source = tokens[env]

      if (!source) throw new Error(`No Doppler service token for env "${env}".`)

      return { token: TOKEN, source }
    },
  }
}

describe('checkEnvTokensConfigured — which envs have a token', () => {
  /** A developer legitimately holds a `dev` token and no `prod` one — failing on that trains everyone to ignore doctor. */
  it('lists every env with its source and never fails on a missing token', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

    const result = await checkEnvTokensConfigured(configured(), depsFor({ dev: 'store' }))

    expect(result.status).toBe('pass')
    expect(result.message).toBe('dev: token (store), prod: no token')
  })

  it('passes with a sentence, not an empty row, when the project declares no envs', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue([])

    const result = await checkEnvTokensConfigured(configured(), depsFor({}))

    expect(result).toMatchObject({ status: 'pass', message: 'no envs declared' })
  })

  it('reports the CI channel as the source when the token comes from the environment', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev'])

    const result = await checkEnvTokensConfigured(configured(), depsFor({ dev: 'env' }))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('dev: token (env)')
  })

  /** A corrupt store throws for EVERY env — rendering that as "no tokens" would point at the wrong fix. */
  it('surfaces a corrupt token store as its own FAIL rather than as "no token anywhere"', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev'])

    const result = await checkEnvTokensConfigured(configured(), {
      ...depsFor({ dev: 'store' }),
      readStore: async () => {
        throw new Error('Invalid JSON in the token store at ~/.infra-kit/projects/api/tokens.json')
      },
    })

    expect(result.status).toBe('fail')
    expect(result.message).toContain('Token store unreadable')
    expect(result.message).toContain('Invalid JSON in the token store')
  })

  /**
   * The absent store is `tokens.json present`'s failure, with the same root cause and the same fix
   * command. Failing here too would print TWO reds for one problem on the most ordinary broken setup
   * there is — see the pair test at the bottom of this file, which is what pins the count at one.
   */
  it('stays a listing when the store holds nothing at all — tokens.json present owns that failure', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

    const result = await checkEnvTokensConfigured(configured(), depsFor({}))

    expect(result.status).toBe('pass')
    expect(result.message).toBe('dev: no token, prod: no token')
  })

  // Was a pass; principle 2: a check that did not evaluate is a skip, never a pass, so the report can tell "never looked" from "looked and fine".
  it('skips when the infra-kit config could not be read — doctor is the escape hatch for that', async () => {
    const result = await checkEnvTokensConfigured({ config: null, error: new Error('bad config') }, depsFor({}))

    expect(result.status).toBe('skip')
    expect(result.message).toContain('could not be read')
    // Bails before ever asking what envs exist.
    expect(listProjectEnvNames).not.toHaveBeenCalled()
  })
})

/** A fake fs: `paths` maps an absolute path to its permission bits; anything absent does not exist. */
const permDeps = (paths: Record<string, number>, chmods: Array<[string, number]> = []): EnvTokenCheckDeps => {
  return {
    storePath: async () => {
      return '/home/u/.infra-kit/projects/api/tokens.json'
    },
    statPath: (target: string) => {
      const mode = paths[target]

      return mode === undefined ? null : ({ mode: 0o100_000 | mode } as fs.Stats)
    },
    chmodPath: (target: string, mode: number) => {
      chmods.push([target, mode])
    },
  }
}

const STORE = '/home/u/.infra-kit/projects/api/tokens.json'
const PROJECT_DIR = '/home/u/.infra-kit/projects/api'
const PROJECTS_DIR = '/home/u/.infra-kit/projects'
const CONFIG_DIR = '/home/u/.infra-kit'

const tightPaths = (): Record<string, number> => {
  return { [STORE]: 0o600, [PROJECT_DIR]: 0o700, [PROJECTS_DIR]: 0o700, [CONFIG_DIR]: 0o700 }
}

describe('checkTokenStorePerms — the credential file is 0600 behind 0700 dirs', () => {
  it('passes when the file and every parent directory are tight', async () => {
    const result = await checkTokenStorePerms(false, permDeps(tightPaths()))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('is 0600 (0700 dirs)')
  })

  /**
   * The ABSENCE itself is `tokens.json present`'s failure; this check only ever grades modes. It was a
   * pass; with no mode read it is a skip (principle 2), and still not a second failure.
   */
  it('skips when there is no token store — there is nothing to protect, and it is reported elsewhere', async () => {
    const result = await checkTokenStorePerms(false, permDeps({}))

    expect(result.status).toBe('skip')
    expect(result.message).toContain('see tokens.json present')
  })

  it('fAILS a world-readable tokens.json and names the mode', async () => {
    const result = await checkTokenStorePerms(false, permDeps({ ...tightPaths(), [STORE]: 0o644 }))

    expect(result.status).toBe('fail')
    expect(result.message).toContain('is 0644, expected 0600')
    expect(result.message).toContain('infra-kit doctor')
  })

  it('fAILS a loose parent directory — a 0600 file in a 0755 chain is still a `find` away', async () => {
    const result = await checkTokenStorePerms(false, permDeps({ ...tightPaths(), [PROJECT_DIR]: 0o755 }))

    expect(result.status).toBe('fail')
    expect(result.message).toContain('is 0755, expected 0700')
  })

  it('does not chmod anything without --fix', async () => {
    const chmods: Array<[string, number]> = []

    await checkTokenStorePerms(false, permDeps({ ...tightPaths(), [STORE]: 0o644 }, chmods))

    expect(chmods).toEqual([])
  })

  it('--fix tightens every loose path and reports a pass', async () => {
    const chmods: Array<[string, number]> = []
    const result = await checkTokenStorePerms(
      true,
      permDeps({ ...tightPaths(), [STORE]: 0o644, [PROJECTS_DIR]: 0o755 }, chmods),
    )

    expect(result.status).toBe('pass')
    expect(chmods).toEqual([
      [PROJECTS_DIR, 0o700],
      [STORE, 0o600],
    ])
  })

  it('skips when the store path cannot be resolved (outside a git repo)', async () => {
    const result = await checkTokenStorePerms(false, {
      storePath: async () => {
        throw new Error('not a git repository')
      },
    })

    expect(result.status).toBe('skip')
    expect(result.message).toContain('could not be resolved')
  })
})

/**
 * The store as the presence check sees it: a parsed store, `null` for no file at all, or `'corrupt'`
 * for the one state `readTokenStore` reports by THROWING. `envToken` stands in for the ambient
 * `INFRA_KIT_ENV_TOKEN` — read through a seam precisely so a developer whose shell has already
 * sourced an `env-load` file does not silently run this file against the skip branch.
 */
const storeDeps = (store: TokenStore | null | 'corrupt', envToken?: string): EnvTokenCheckDeps => {
  return {
    storePath: async () => {
      return STORE
    },
    readStore: async () => {
      if (store === 'corrupt') throw new Error('Invalid JSON in the token store')

      return store
    },
    readEnvToken: () => {
      return envToken
    },
  }
}

describe('checkTokenStorePresent — every project needs a token store', () => {
  it('fAILS when there is no store at all, and names the path and the fix', async () => {
    const result = await checkTokenStorePresent(storeDeps(null))

    expect(result.status).toBe('fail')
    expect(result.message).toContain('No token store at')
    expect(result.message).toContain('infra-kit env-token-set')
  })

  it('fAILS a store that exists but holds no tokens — an empty store is the same as none', async () => {
    const result = await checkTokenStorePresent(storeDeps({ version: 1, envs: {} }))

    expect(result.status).toBe('fail')
    expect(result.message).toContain('holds no tokens')
  })

  it('passes and names the envs held (never the tokens) when the store is populated', async () => {
    const result = await checkTokenStorePresent(storeDeps({ version: 1, envs: { dev: TOKEN, prod: TOKEN } }))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('holds 2 token(s): dev, prod')
    expect(result.message).not.toContain(TOKEN)
  })

  /**
   * CI and agents authenticate through the variable and never write a store — failing them is noise.
   * It was a pass; the store was never looked at, so it is a skip (principle 2).
   */
  it('skips when INFRA_KIT_ENV_TOKEN is set, even with no store on disk', async () => {
    const result = await checkTokenStorePresent(storeDeps(null, TOKEN))

    expect(result.status).toBe('skip')
    expect(result.message).toContain('INFRA_KIT_ENV_TOKEN')
    expect(result.message).not.toContain(TOKEN)
  })

  /** An EMPTY variable is a miss, not a token — the same rule `resolveEnvToken` applies. */
  it('does not treat an empty INFRA_KIT_ENV_TOKEN as a token', async () => {
    const result = await checkTokenStorePresent({
      ...storeDeps(null),
      readEnvToken: () => {
        return ''
      },
    })

    expect(result.status).toBe('fail')
  })

  /**
   * A corrupt store is already the FAIL of `env tokens configured`; failing twice double-counts it. It
   * is a skip, not the old pass, because the store's content was never read (principle 2).
   */
  it('defers to env tokens configured when the store is unreadable', async () => {
    const result = await checkTokenStorePresent(storeDeps('corrupt'))

    expect(result.status).toBe('skip')
    expect(result.message).toContain('see env tokens configured')
  })

  it('skips when the store path cannot be resolved (outside a git repo)', async () => {
    const result = await checkTokenStorePresent({
      readEnvToken: () => {
        return undefined
      },
      storePath: async () => {
        throw new Error('not a git repository')
      },
    })

    expect(result.status).toBe('skip')
    expect(result.message).toContain('could not be resolved')
  })
})

/**
 * ONE root cause, ONE red line. The per-function tests above are structurally blind to this: each
 * check is correct in isolation while the SECTION double-reports. The pair below is the exact machine
 * this change was written for — a fresh checkout with no token store — and the count, not the
 * verdicts, is what is being pinned.
 */
describe('the token checks never print two failures for one root cause', () => {
  it('reports an absent store exactly once across the whole section', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

    const read = configured()
    const deps = depsFor({})
    // Both fixtures, merged: `depsFor` carries the resolver and an (agreeing) empty store, `storeDeps`
    // carries the store PATH and the env-var seam. Without the latter the presence check would spawn
    // `git rev-parse` and read the real `INFRA_KIT_ENV_TOKEN` off the developer's shell.
    const results = [
      await checkTokenStorePresent({ ...storeDeps(null), ...deps }),
      await checkEnvTokensConfigured(read, deps),
      await checkTokenStorePerms(false, permDeps({})),
    ]
    const failed = results.filter((result) => {
      return result.status === 'fail'
    })

    expect(
      failed.map((result) => {
        return result.name
      }),
    ).toEqual(['tokens.json present'])
  })
})

/**
 * The one rule a credential path cannot bend. Every branch of all three checks, rendered, grepped for
 * the token literal. It is a MATRIX rather than a spot-check because the leak that matters is the one
 * in the branch nobody thought to assert on.
 */
describe('no doctor message ever contains a token value', () => {
  const tokenMaps: TokenMap[] = [{ dev: 'store' }, { dev: 'env' }, { prod: 'store' }, {}]
  /** Every state `checkTokenStorePresent` renders — including a POPULATED store, whose values are tokens. */
  const stores: Array<TokenStore | null | 'corrupt'> = [
    null,
    'corrupt',
    { version: 1, envs: {} },
    { version: 1, envs: { dev: TOKEN, prod: TOKEN } },
  ]

  it('renders the whole check matrix and finds zero token literals', async () => {
    const messages: string[] = []

    for (const store of stores) {
      for (const envToken of [undefined, TOKEN]) {
        messages.push((await checkTokenStorePresent(storeDeps(store, envToken))).message)
      }
    }

    for (const tokens of tokenMaps) {
      vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

      messages.push(
        (await checkEnvTokensConfigured(configured(), depsFor(tokens))).message,
        (await checkTokenStorePerms(false, permDeps({ ...tightPaths(), [STORE]: 0o644 }))).message,
      )
    }

    // The matrix must actually have rendered something, or the grep below is vacuous.
    expect(messages).toHaveLength(stores.length * 2 + tokenMaps.length * 2)

    for (const message of messages) {
      expect(message).not.toContain(TOKEN)
      expect(message).not.toContain('dp.st.')
    }
  })
})
