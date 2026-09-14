import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetZxFactoryArgs, zxFactoryArgs, zxTagCalls } from 'src/lib/quiet-shell/__tests__/zx-shell-mock'

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

vi.mock('zx', async () => {
  // Imported INSIDE the factory: `vi.mock` is hoisted above the imports, and `doctor.ts` pulls
  // in `zx` at module scope, so a top-level binding is still in its TDZ when this runs.
  const { zxShellMock } = await import('src/lib/quiet-shell/__tests__/zx-shell-mock')

  return zxShellMock((_strings: TemplateStringsArray, command: string[]) => {
    if (failing.has(command[0] ?? '')) return Promise.reject(new Error('exit 127'))

    return Promise.resolve({ stdout: '' })
  })
})

vi.mock('src/lib/env-tokens', () => {
  return {
    readTokenStore: vi.fn(() => {
      return Promise.resolve({ version: 1, envs: { dev: 'redacted' } })
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
    // `portless service target` reads the service file at these paths and dates the daemon from the pid
    // under the state dir; both are pointed nowhere so the row is its `Skipped —` pass on every machine.
    DARWIN_SERVICE_LABEL: 'sh.portless.proxy',
    DARWIN_SERVICE_PLIST_PATH: '/nowhere/LaunchDaemons/sh.portless.proxy.plist',
    LINUX_SERVICE_UNIT_NAME: 'portless',
    LINUX_SERVICE_UNIT_PATH: '/nowhere/systemd/portless.service',
    portlessStateDir: vi.fn(() => {
      return '/nowhere/.portless'
    }),
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
  resetZxFactoryArgs()
})

/**
 * `checkCommand` probes binaries that are routinely ABSENT — that is the whole point of the row — and
 * zx relays a child's stderr to the parent's by default, so an unconfigured `$` here printed
 * `command not found` into the terminal of every `doctor` run, in the shell's voice. The verdict below
 * is identical either way, so the option itself is what has to be asserted.
 */
describe('the binary probes capture their output instead of relaying it', () => {
  it('configures zx quiet before shelling out', async () => {
    failing.add('cmux')
    await runCheck('terminal installed')

    expect(zxFactoryArgs).toContainEqual({ quiet: true })
  })

  // Asserting only that SOME call configured the shell would stay green with one site reverted, since
  // the others still configure theirs. Every command actually run has to have come from a configured
  // shell, which is why the mock records the tag calls and not just the configuration.
  it('leaves no probe anywhere in the report on an unconfigured shell', async () => {
    await doctor()

    expect(zxTagCalls.length).toBeGreaterThan(0)
    expect(
      zxTagCalls.filter((call) => {
        return !call.configured
      }),
    ).toEqual([])
    expect(
      zxFactoryArgs.filter((args) => {
        return (args as { quiet?: boolean } | undefined)?.quiet !== true
      }),
    ).toEqual([])
  })
})

describe('package manager installed', () => {
  it('passes naming the package manager when pnpm --version succeeds', async () => {
    await expect(runCheck('package manager installed')).resolves.toEqual({
      name: 'package manager installed',
      status: 'pass',
      message: 'Installed: pnpm',
      // Payload rows carry `fixable`, and a probe row is not one `--fix` repairs.
      fixable: false,
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
      fixable: false,
    })
  })

  it('fails with an install hint when cmux is absent', async () => {
    failing.add('cmux')

    const check = await runCheck('terminal installed')

    expect(check.status).toBe('fail')
    expect(check.message).toBe('cmux is not installed. Install from: https://cmux.com/')
  })
})
