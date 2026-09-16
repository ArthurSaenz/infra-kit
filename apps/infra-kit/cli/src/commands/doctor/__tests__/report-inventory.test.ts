import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'

import packageJson from '../../../../package.json' with { type: 'json' }
import { doctor } from '../doctor'
import { DOCTOR_CHECK_NAMES, FIXABLE_NAMES } from '../report'

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

/**
 * A git root with NO `infra-kit.json` — the repo shape the gate split exists to serve, where the
 * writer acts and the old reader gate would have shown no row at all.
 *
 * Its `.mcp.json` is deliberately unparseable, because that verdict is a FINGERPRINT of this exact
 * path: no other directory the suite could accidentally read produces it. `process.cwd()` under
 * vitest is the package dir, which has no `.mcp.json` and reads as `missing-file`; the repository
 * root's own file is valid and reads as `ok`.
 */
let gitOnlyDir: string | null = null

const ensureGitOnlyFixture = (): string => {
  if (gitOnlyDir !== null) return gitOnlyDir

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-inventory-gitonly-'))

  fs.writeFileSync(path.join(dir, '.mcp.json'), 'not json at all')
  gitOnlyDir = dir

  return dir
}

/**
 * What the git seam answers. `null` is the ordinary case — the same fixture the config seam names, so
 * the git root and the infra-kit root coincide as they do in a real infra-kit repo. The gate tests
 * below drive the two cases where they do not.
 */
let gitTopLevel: string | null = null

/**
 * The git seam, mocked DELIBERATELY: it is load-bearing for the row set, not incidental to it.
 *
 * `MCP server key` renders iff `resolveGitRoot()` — `git rev-parse --show-toplevel` — answers a
 * usable root, so an unmocked seam would make this suite's answer depend on where vitest was launched
 * and on the working tree's state. The `zx` mock below is NOT a substitute: blank stdout is a REFUSAL
 * by contract, so with only that mock the row is omitted and this reconciliation fails. Making the
 * `zx` mock command-aware is the wrong fix — it means string-matching template literals, and it
 * perturbs every other `$` consumer inside `doctor()`.
 */
vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(() => {
      return Promise.resolve(gitTopLevel ?? ensureFixture())
    }),
  }
})

/**
 * `portless service target` reads the service file at the driver's fixed path and, when it parses, dates
 * the daemon through `ps`. Both constants are pointed at paths that cannot exist so the row is the
 * deterministic `Skipped —` pass on every machine — including one with a real root plist — and no `ps`
 * is ever spawned: the pid file lives under the same unreachable state dir.
 */
vi.mock('src/dev/proxy/portless-driver', () => {
  return {
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

vi.mock('zx', () => {
  return {
    $: vi.fn(() => {
      return Promise.resolve({ stdout: '' })
    }),
  }
})

/**
 * `logger.info` for the run under test.
 *
 * Spied, not module-mocked, so the rest of `src/lib/logger` stays real for the other modules in
 * `doctor`'s import graph.
 */
const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})

/** The writer's four-step skip — `initCore`'s line, which `doctor` must never emit. */
const GIT_ROOT_SKIP = /^Skipped agent-instruction files, the plugin pointer, the plugin install and \.mcp\.json —/

const infoLinesMatching = (pattern: RegExp): string[] => {
  return infoSpy.mock.calls
    .map((call) => {
      return typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0])
    })
    .filter((line) => {
      return pattern.test(line)
    })
}

afterEach(() => {
  gitTopLevel = null
  infoSpy.mockClear()
})

afterAll(() => {
  if (fixtureDir !== null) fs.rmSync(fixtureDir, { recursive: true, force: true })
  if (gitOnlyDir !== null) fs.rmSync(gitOnlyDir, { recursive: true, force: true })
})

const producedNames = async (): Promise<string[]> => {
  const { checks } = (await doctor()).structuredContent

  return checks.map((check) => {
    return check.name
  })
}

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

/**
 * The two fields a non-terminal caller reads. Asserted against their SOURCES rather than against
 * literals: `fixable` against `FIXABLE_NAMES` itself, because a hand-written second list is the
 * drift the field exists to avoid, and `cliVersion` against `package.json`, because the value is a
 * version floor's own datum.
 */
describe('doctor --json payload', () => {
  it('marks exactly the FIXABLE_NAMES rows fixable', async () => {
    const { checks } = (await doctor()).structuredContent
    const fixable = checks
      .filter((check) => {
        return check.fixable
      })
      .map((check) => {
        return check.name
      })

    expect([...fixable].sort()).toEqual([...FIXABLE_NAMES].sort())
  })

  it('reports the CLI version as a top-level field', async () => {
    expect((await doctor()).structuredContent.cliVersion).toBe(packageJson.version)
  })
})

/**
 * The row set follows the WRITER's gate. Both cases here are ones the old `infra-kit.json` predicate
 * got wrong: it hid the row where `initCore` writes the file, and it would have rendered the row against
 * `process.cwd()` where `git rev-parse` answers nothing.
 */
describe('the MCP server key and Agent allowlist rows are gated on the git root', () => {
  it('render in a git repo with no infra-kit.json', async () => {
    gitTopLevel = ensureGitOnlyFixture()

    const produced = await producedNames()

    expect(produced).toContain('MCP server key')
    expect(produced).toContain('Agent allowlist')
  })

  /**
   * The guard against a green that came from the live tree rather than from the mock. The verdict
   * asserted here is only producible by the fixture's own deliberately-broken `.mcp.json`, so this
   * fails if the row is ever answered against `process.cwd()` — the failure mode a real git seam, or
   * a blank-stdout one without the refusal, would silently pass.
   */
  it('answers against the mocked root, not the directory vitest was launched from', async () => {
    gitTopLevel = ensureGitOnlyFixture()

    const { checks } = (await doctor()).structuredContent
    const row = checks.find((check) => {
      return check.name === 'MCP server key'
    })

    expect(row?.message).toContain('Could not read mcpServers')
  })

  it('are omitted, not answered against the cwd, when the git seam is blank', async () => {
    gitTopLevel = ''

    const produced = await producedNames()

    expect(produced).not.toContain('MCP server key')
    expect(produced).not.toContain('Agent allowlist')
    // `doctor` is READ-ONLY. It borrows the writer's predicate to decide the row set; it skips
    // nothing and intends to write nothing, so the writer's four-step skip line must not reach
    // someone who only ran the diagnostic — least of all as stderr line 1, above the report header.
    expect(infoLinesMatching(GIT_ROOT_SKIP)).toHaveLength(0)
    expect([...produced].sort()).toEqual(
      [...DOCTOR_CHECK_NAMES]
        .filter((name) => {
          return name !== 'MCP server key' && name !== 'Agent allowlist'
        })
        .sort(),
    )
  })
})
