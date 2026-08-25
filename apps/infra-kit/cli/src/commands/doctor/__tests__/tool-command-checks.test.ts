import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { doctor } from '../doctor'
import type { CheckResult } from '../doctor'

/**
 * The pass/fail contract of the binary-probe checks — the ones whose whole implementation is
 * "did `<tool> --version` exit 0?". `report-inventory.test.ts` proves they are EMITTED; it mocks
 * `zx` to always resolve, so it can never tell a passing probe from one wired to the wrong binary.
 * Here the mocked `$` fails a chosen command, which is what pins each check name to the binary it
 * actually shells out to.
 */

/** Command names the mocked `$` rejects for; empty means every probe succeeds. */
const failing = new Set<string>()

vi.mock('zx', () => {
  return {
    $: vi.fn((_strings: TemplateStringsArray, command: string[]) => {
      if (failing.has(command[0] ?? '')) return Promise.reject(new Error('exit 127'))

      return Promise.resolve({ stdout: '' })
    }),
  }
})

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
      return Promise.resolve({})
    }),
    getInfraKitConfigPaths: vi.fn(() => {
      return Promise.resolve({
        main: path.join('/nowhere', 'infra-kit.json'),
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

const runCheck = async (name: string): Promise<CheckResult> => {
  const check = (await doctor()).structuredContent.checks.find((candidate) => {
    return candidate.name === name
  })

  if (!check) throw new Error(`doctor() emitted no check named "${name}"`)

  return check
}

beforeEach(() => {
  failing.clear()
})

describe('package manager installed', () => {
  it('passes naming the package manager when pnpm --version succeeds', async () => {
    await expect(runCheck('package manager installed')).resolves.toEqual({
      name: 'package manager installed',
      status: 'pass',
      message: 'Installed: pnpm',
    })
  })

  it('fails with an install hint when pnpm is absent', async () => {
    failing.add('pnpm')

    const check = await runCheck('package manager installed')

    expect(check.status).toBe('fail')
    expect(check.message).toBe('pnpm is not installed. Install from: https://pnpm.io/installation')
  })
})

describe('terminal installed', () => {
  it('passes naming the terminal when cmux --version succeeds', async () => {
    await expect(runCheck('terminal installed')).resolves.toEqual({
      name: 'terminal installed',
      status: 'pass',
      message: 'Installed: cmux',
    })
  })

  it('fails with an install hint when cmux is absent', async () => {
    failing.add('cmux')

    const check = await runCheck('terminal installed')

    expect(check.status).toBe('fail')
    expect(check.message).toBe('cmux is not installed. Install from: https://cmux.com/')
  })
})
