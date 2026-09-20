import type fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvTokenProbe, ResolvedEnvToken } from 'src/integrations/doppler'
import type { TokenStore } from 'src/lib/env-tokens'
import type { InfraKitConfig } from 'src/lib/infra-kit-config'
import { listProjectEnvNames } from 'src/lib/project-envs'

import type { DoctorConfig, EnvTokenCheckDeps } from '../doctor'
import { checkEnvTokenValid, checkEnvTokensConfigured, checkTokenStorePerms, checkTokenStorePresent } from '../doctor'

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
 * matrix below renders EVERY branch of all three checks and greps the lot.
 */
const TOKEN = 'dp.st.dev.SUPER-SECRET-DO-NOT-PRINT'

/** The merged config as doctor already read it (see `readDoctorConfig`). */
const configured = (autoLoadEnv?: string): DoctorConfig => {
  return {
    config: {
      envManagement: { provider: 'doppler', config: { name: 'api' } },
      ...(autoLoadEnv === undefined ? {} : { envAutoLoad: { trigger: 'shell-startup', config: autoLoadEnv } }),
    } as unknown as InfraKitConfig,
    error: null,
  }
}

/** How each env's token resolves. A missing entry = no token (the resolver throws). */
type TokenMap = Record<string, ResolvedEnvToken['source']>

const depsFor = (tokens: TokenMap, probe?: EnvTokenProbe): EnvTokenCheckDeps => {
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
    probe: async () => {
      return probe ?? { outcome: 'valid', scopedTo: 'dev' }
    },
  }
}

describe('checkEnvTokensConfigured — which envs have a token, and is the load-bearing one among them', () => {
  it('passes and names the source when the auto-load env has a token', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

    const result = await checkEnvTokensConfigured(configured('dev'), depsFor({ dev: 'store' }))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('auto-load env "dev": token (store)')
    expect(result.message).toContain('dev: token (store)')
  })

  it('reports the CI channel as the source when the token comes from the environment', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev'])

    const result = await checkEnvTokensConfigured(configured('dev'), depsFor({ dev: 'env' }))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('token (env)')
  })

  /** Token-only auth has no fallback: no token for the auto-load env means the shell silently stops loading. */
  it('fAILS when the auto-load env has no token', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

    const result = await checkEnvTokensConfigured(configured('dev'), depsFor({ prod: 'store' }))

    expect(result.status).toBe('fail')
    expect(result.message).toContain('auto-load env "dev"')
    expect(result.message).toContain('infra-kit env-token-set dev')
  })

  /** A developer legitimately holds a `dev` token and no `prod` one — failing on that trains everyone to ignore doctor. */
  it('passes when a NON-auto-load env has no token, and still lists it', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

    const result = await checkEnvTokensConfigured(configured('dev'), depsFor({ dev: 'store' }))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('prod: no token')
  })

  it('passes with a listing when envAutoLoad is not configured — no env is load-bearing', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

    const result = await checkEnvTokensConfigured(configured(), depsFor({}))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('No envAutoLoad configured')
    expect(result.message).toContain('dev: no token, prod: no token')
  })

  it('fAILS when the auto-load env is declared by no workflow and holds no token, appending it to the listing', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev'])

    const result = await checkEnvTokensConfigured(configured('staging'), depsFor({ dev: 'store' }))

    expect(result.status).toBe('fail')
    expect(result.message).toContain('auto-load env "staging"')
    expect(result.message).toContain('infra-kit env-token-set staging')
    // The auto-load env is probed even though nothing declares it — appended to the universe.
    expect(result.message).toContain('staging: no token')
  })

  /** A corrupt store throws for EVERY env — rendering that as "no tokens" would point at the wrong fix. */
  it('surfaces a corrupt token store as its own FAIL rather than as "no token anywhere"', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev'])

    const result = await checkEnvTokensConfigured(configured('dev'), {
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
  it('defers to tokens.json present when the store holds nothing at all', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

    const result = await checkEnvTokensConfigured(configured('dev'), depsFor({}))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('see tokens.json present')
  })

  it('defers the same way for a store that exists but was hand-edited empty', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev'])

    const result = await checkEnvTokensConfigured(configured('dev'), {
      ...depsFor({}),
      readStore: async () => {
        return { version: 1, envs: {} }
      },
    })

    expect(result.status).toBe('pass')
    expect(result.message).toContain('see tokens.json present')
  })

  it('skips (passes) when the infra-kit config could not be read — doctor is the escape hatch for that', async () => {
    const result = await checkEnvTokensConfigured({ config: null, error: new Error('bad config') }, depsFor({}))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('Skipped')
    // Bails before ever asking what envs exist.
    expect(listProjectEnvNames).not.toHaveBeenCalled()
  })
})

describe('checkEnvTokenValid — is the auto-load env token live and correctly scoped', () => {
  const cases: Array<{ probe: EnvTokenProbe; status: 'pass' | 'fail'; matches: RegExp }> = [
    { probe: { outcome: 'valid', scopedTo: 'dev' }, status: 'pass', matches: /live and correctly scoped/ },
    { probe: { outcome: 'revoked' }, status: 'fail', matches: /REJECTED by Doppler/ },
    { probe: { outcome: 'mis-scoped' }, status: 'fail', matches: /scoped to a DIFFERENT config/ },
    { probe: { outcome: 'unreachable' }, status: 'pass', matches: /could not be checked/ },
  ]

  for (const testCase of cases) {
    it(`reports ${testCase.probe.outcome} as a ${testCase.status}`, async () => {
      const result = await checkEnvTokenValid(configured('dev'), depsFor({ dev: 'store' }, testCase.probe))

      expect(result.status).toBe(testCase.status)
      expect(result.message).toMatch(testCase.matches)
    })
  }

  /** A failed probe proves nothing about a token. Reporting "revoked" to a developer on a plane is worse than silence. */
  it('never turns an unreachable Doppler into a verdict about the token', async () => {
    const result = await checkEnvTokenValid(configured('dev'), depsFor({ dev: 'store' }, { outcome: 'unreachable' }))

    expect(result.status).toBe('pass')
    expect(result.message).not.toMatch(/revoked|invalid|mis-scoped/i)
  })

  it('probes ONLY the auto-load env, never the other environments', async () => {
    const probe = vi.fn(async (): Promise<EnvTokenProbe> => {
      return { outcome: 'valid', scopedTo: 'dev' }
    })

    await checkEnvTokenValid(configured('dev'), {
      ...depsFor({ dev: 'store', prod: 'store' }),
      probe,
    })

    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ config: 'dev', project: 'api' }))
  })

  it('skips when there is no envAutoLoad env to probe', async () => {
    const result = await checkEnvTokenValid(configured(), depsFor({ dev: 'store' }))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('no envAutoLoad env to probe')
  })

  /** The missing token is already the FAIL of `env tokens configured`; failing twice double-counts one problem. */
  it('skips (rather than double-failing) when the auto-load env has no token', async () => {
    const result = await checkEnvTokenValid(configured('dev'), depsFor({}))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('see env tokens configured')
  })

  it('skips when the infra-kit config could not be read', async () => {
    const result = await checkEnvTokenValid({ config: null, error: new Error('bad config') }, depsFor({}))

    expect(result.status).toBe('pass')
    expect(result.message).toContain('Skipped')
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

  /** The ABSENCE itself is `tokens.json present`'s failure; this check only ever grades modes. */
  it('skips (passes) when there is no token store — there is nothing to protect, and it is reported elsewhere', async () => {
    const result = await checkTokenStorePerms(false, permDeps({}))

    expect(result.status).toBe('pass')
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

    expect(result.status).toBe('pass')
    expect(result.message).toContain('Skipped')
  })
})

/**
 * The store as the presence check sees it: a parsed store, `null` for no file at all, or `'corrupt'`
 * for the one state `readTokenStore` reports by THROWING. `envToken` stands in for the ambient
 * `INFRA_KIT_ENV_TOKEN` — read through a seam precisely so a developer whose shell has already
 * auto-loaded an env does not silently run this file against the skip branch.
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

  /** CI and agents authenticate through the variable and never write a store — failing them is noise. */
  it('skips when INFRA_KIT_ENV_TOKEN is set, even with no store on disk', async () => {
    const result = await checkTokenStorePresent(storeDeps(null, TOKEN))

    expect(result.status).toBe('pass')
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

  /** A corrupt store is already the FAIL of `env tokens configured`; failing twice double-counts it. */
  it('defers to env tokens configured when the store is unreadable', async () => {
    const result = await checkTokenStorePresent(storeDeps('corrupt'))

    expect(result.status).toBe('pass')
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

    expect(result.status).toBe('pass')
    expect(result.message).toContain('Skipped')
  })
})

/**
 * ONE root cause, ONE red line. The per-function tests above are structurally blind to this: each
 * check is correct in isolation while the SECTION double-reports. The pair below is the exact machine
 * this change was written for — a checkout that configures `envAutoLoad` and has no token store — and
 * the count, not the verdicts, is what is being pinned.
 */
describe('the token checks never print two failures for one root cause', () => {
  it('reports an absent store exactly once across the whole section', async () => {
    vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

    const read = configured('dev')
    const deps = depsFor({})
    // Both fixtures, merged: `depsFor` carries the resolver and an (agreeing) empty store, `storeDeps`
    // carries the store PATH and the env-var seam. Without the latter the presence check would spawn
    // `git rev-parse` and read the real `INFRA_KIT_ENV_TOKEN` off the developer's shell.
    const results = [
      await checkTokenStorePresent({ ...storeDeps(null), ...deps }),
      await checkEnvTokensConfigured(read, deps),
      await checkEnvTokenValid(read, deps),
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
 * The one rule a credential path cannot bend. Every branch of all four checks, rendered, grepped for
 * the token literal. It is a MATRIX rather than a spot-check because the leak that matters is the one
 * in the branch nobody thought to assert on.
 */
describe('no doctor message ever contains a token value', () => {
  const outcomes: EnvTokenProbe[] = [
    { outcome: 'valid', scopedTo: 'dev' },
    { outcome: 'revoked' },
    { outcome: 'mis-scoped', scopedTo: 'prod' },
    { outcome: 'unreachable' },
  ]
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

    for (const autoLoadEnv of ['dev', undefined]) {
      for (const tokens of tokenMaps) {
        for (const probe of outcomes) {
          vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod'])

          const read = configured(autoLoadEnv)
          const deps = depsFor(tokens, probe)

          messages.push(
            (await checkEnvTokensConfigured(read, deps)).message,
            (await checkEnvTokenValid(read, deps)).message,
            (await checkTokenStorePerms(false, permDeps({ ...tightPaths(), [STORE]: 0o644 }))).message,
          )
        }
      }
    }

    // The matrix must actually have rendered something, or the grep below is vacuous.
    expect(messages).toHaveLength(stores.length * 2 + 2 * tokenMaps.length * outcomes.length * 3)

    for (const message of messages) {
      expect(message).not.toContain(TOKEN)
      expect(message).not.toContain('dp.st.')
    }
  })
})
