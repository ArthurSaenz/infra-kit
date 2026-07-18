import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { doctor } from '../doctor'
import { DOCTOR_CHECK_NAMES } from '../report'

/**
 * The reconciliation half of the section-map drift guard.
 *
 * `report.test.ts` proves every name in {@link DOCTOR_CHECK_NAMES} maps to a real section. That alone
 * is a closed loop — the inventory and the map could agree with each other while both drifted away
 * from what `doctor()` actually emits, and a newly added check would quietly land in `Other` with a
 * green suite. This test closes the loop by running the REAL `doctor()` and asserting the names it
 * produces are exactly the inventory.
 *
 * Every external seam is mocked so the set is deterministic rather than machine-dependent: on a
 * machine with no portless binary `checkPortless` returns 1 name instead of 5, and outside an
 * infra-kit repo `checkAgentFiles` returns none at all.
 */

/**
 * `checkAgentFiles` bails unless the main config exists, and reads CLAUDE.md from beside it — so the
 * fixture is a temp dir holding both. Built LAZILY (on first call from the mocked resolver) rather
 * than in a `vi.hoisted` block: hoisted code runs before the static imports are initialised, which is
 * what would otherwise force `require()` here.
 */
let fixtureDir: string | null = null

const ensureFixture = (): string => {
  if (fixtureDir !== null) return fixtureDir

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-inventory-'))

  fs.writeFileSync(path.join(dir, 'infra-kit.json'), '{}')
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# no managed block here')
  fixtureDir = dir

  return dir
}

vi.mock('src/lib/env-tokens', () => {
  return {
    readTokenStore: vi.fn(() => {
      return Promise.resolve({})
    }),
    getTokenStorePath: vi.fn(() => {
      return Promise.resolve('/nowhere/tokens.json')
    }),
  }
})

vi.mock('src/integrations/doppler', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('src/integrations/doppler')>()),
    resolveEnvToken: vi.fn(() => {
      return Promise.resolve({ token: 'redacted', source: 'store' })
    }),
    probeEnvToken: vi.fn(() => {
      return Promise.resolve({ outcome: 'unreachable' })
    }),
  }
})

vi.mock('src/lib/project-envs', () => {
  return {
    listProjectEnvNames: vi.fn(() => {
      return Promise.resolve(['dev'])
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
        main: path.join(ensureFixture(), 'infra-kit.json'),
        userGlobal: '/nowhere/user/infra-kit.json',
        userProject: '/nowhere/user/projects/api/infra-kit.json',
        projectName: 'api',
      })
    }),
    resolveConfiguredIdes: vi.fn(() => {
      return [{ provider: 'zed' }]
    }),
  }
})

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

afterAll(() => {
  if (fixtureDir !== null) fs.rmSync(fixtureDir, { recursive: true, force: true })
})

describe('doctor check inventory', () => {
  it('produces exactly the names the section map is built from', async () => {
    const produced = (await doctor()).structuredContent.checks.map((check) => {
      return check.name
    })

    expect([...produced].sort()).toEqual([...DOCTOR_CHECK_NAMES].sort())
  })

  it('emits each check exactly once', async () => {
    const produced = (await doctor()).structuredContent.checks.map((check) => {
      return check.name
    })

    expect(new Set(produced).size).toBe(produced.length)
  })
})
