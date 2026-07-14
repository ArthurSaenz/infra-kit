import { describe, expect, it, vi } from 'vitest'

import { doctor } from '../doctor'

/**
 * The whole point of `doctor` is that it still RUNS when the machine is broken — it is the escape
 * hatch, so any check that throws instead of failing takes the diagnosis down with it. A corrupt
 * `tokens.json` (hand-edited, half-synced, truncated) is precisely the state a user runs it in.
 */
const CORRUPT = 'Invalid JSON in the token store at ~/.infra-kit/projects/api/tokens.json: Unexpected token }'

vi.mock('src/lib/env-tokens', () => {
  return {
    readTokenStore: vi.fn(() => {
      return Promise.reject(new Error(CORRUPT))
    }),
    getTokenStorePath: vi.fn(() => {
      return Promise.resolve('/home/u/.infra-kit/projects/api/tokens.json')
    }),
  }
})

// Partial: `env-load` (imported for `buildDopplerChildEnv`) pulls its own constants off this barrel, so a
// wholesale replacement breaks the import graph before a single check runs.
vi.mock('src/integrations/doppler', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('src/integrations/doppler')>()),
    resolveEnvToken: vi.fn(() => {
      return Promise.reject(new Error(CORRUPT))
    }),
    probeEnvToken: vi.fn(() => {
      return Promise.resolve({ outcome: 'unreachable' })
    }),
  }
})

vi.mock('src/lib/infra-kit-config', () => {
  return {
    DEFAULT_DEV_PROXY_PORT: 443,
    resetInfraKitConfigCache: vi.fn(),
    getInfraKitConfig: vi.fn(() => {
      return Promise.resolve({
        envManagement: { provider: 'doppler', config: { name: 'api' } },
        envAutoLoad: { trigger: 'shell-startup', config: 'dev' },
      })
    }),
    getInfraKitConfigPaths: vi.fn(() => {
      return Promise.resolve({
        main: '/nowhere/infra-kit.json',
        userGlobal: '/nowhere/user/infra-kit.json',
        userProject: '/nowhere/user/projects/api/infra-kit.json',
        projectName: 'api',
      })
    }),
    resolveConfiguredIdes: vi.fn(() => {
      return []
    }),
  }
})

// The portless block probes :443 on the wire and reads the daemon's CA off disk. Neither belongs in a
// unit test, and neither is what this test is about.
vi.mock('src/dev/proxy/portless-driver', () => {
  return {
    caFingerprintMatches: vi.fn(() => {
      return true
    }),
    createPortlessDriver: vi.fn(() => {
      return { removeAlias: vi.fn() }
    }),
    defaultIsListening: vi.fn(() => {
      return Promise.resolve(true)
    }),
    defaultIsProxyServing: vi.fn(() => {
      return Promise.resolve(true)
    }),
    formatPortlessCommand: vi.fn(() => {
      return 'node portless'
    }),
    handshakeChainsToCa: vi.fn(() => {
      return Promise.resolve({ ok: true })
    }),
    listRoutes: vi.fn(() => {
      return []
    }),
    readCaPath: vi.fn(() => {
      return '/nowhere/ca.pem'
    }),
    resolvePortlessBin: vi.fn(() => {
      return '/nowhere/portless'
    }),
  }
})

vi.mock('zx', () => {
  return {
    $: vi.fn(() => {
      return Promise.resolve({ stdout: '' })
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

describe('doctor with a corrupt tokens.json', () => {
  it('does not throw — it still runs every other check and reports the store error as a FAIL', async () => {
    const result = await doctor()
    const checks = result.structuredContent.checks
    const tokens = checks.find((check) => {
      return check.name === 'env tokens configured'
    })

    expect(tokens?.status).toBe('fail')
    expect(tokens?.message).toContain('Token store unreadable')
    expect(tokens?.message).toContain('Invalid JSON in the token store')

    // The rest of the run is intact: the checks that know nothing about tokens still reported.
    expect(
      checks.map((check) => {
        return check.name
      }),
    ).toEqual(expect.arrayContaining(['gh installed', 'doppler installed', 'infra-kit config valid', 'ide installed']))
  })

  it('has dropped the account-auth checks that token-only auth made unanswerable', async () => {
    const names = (await doctor()).structuredContent.checks.map((check) => {
      return check.name
    })

    expect(names).not.toContain('doppler authenticated')
    expect(names).not.toContain('doppler project exists')
    expect(names).toContain('doppler installed')
  })
})
