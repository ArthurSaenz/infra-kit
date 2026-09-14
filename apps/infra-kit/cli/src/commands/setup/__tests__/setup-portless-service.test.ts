import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { launchdPlist, systemdUnit } from 'src/commands/doctor/__tests__/service-fixtures'
import { InitStepError, initCore } from 'src/commands/init'
import type { InitEntry, InitStepSink } from 'src/commands/init'
import { setup } from 'src/commands/setup'
import type { PortlessServiceDeps } from 'src/commands/setup'
import { fakeLinkFs } from 'src/dev/proxy/__tests__/portless-link-fixtures'
import type { LinkEntry } from 'src/dev/proxy/__tests__/portless-link-fixtures'
import type { EnsurePortlessLinkDeps } from 'src/dev/proxy/portless-link'
import { runRecipe } from 'src/lib/dependency-install'
import type { InstallOutcome } from 'src/lib/dependency-install'
import type { ProbeDeps } from 'src/lib/dependency-probe'
import { logger } from 'src/lib/logger'

/**
 * US-005: `setup` converges `~/.infra-kit/portless` and, only when the installed system service has not
 * caught up to it, prints the ONE `service install` line a human has to run. Everything is injected
 * through {@link PortlessServiceDeps} (an in-memory `fs` for the link, doctor's own service-target seams
 * for the verdict) — no real disk, no real plist, no `ps`, matching `portless-link.test.ts`'s discipline.
 *
 * The service file under test is what portless's own writer would emit (`service-fixtures.ts`), so the
 * verdict is exercised on real bytes — the same bytes doctor's row is proven against.
 *
 * The init half and the dependency half are mocked exactly as `setup-composition.test.ts` mocks them: this
 * suite is about the THIRD step `setup` runs, not about the other two.
 */

vi.mock('src/commands/init', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/commands/init')>()

  return { ...actual, initCore: vi.fn() }
})

vi.mock('src/lib/dependency-install', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/dependency-install')>()

  return {
    ...actual,
    runRecipe: vi.fn((recipe: { steps: string[][] }): InstallOutcome => {
      return {
        ran: true,
        ok: true,
        commands: recipe.steps.map((step) => {
          return step.join(' ')
        }),
      }
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

/** Nothing present: the dependency half has nothing to install or refuse, and prints nothing of its own. */
const nothingInstalled = (): ProbeDeps => {
  return {
    runCommand: async () => {
      throw new Error('not found')
    },
    resolveBinPath: async () => {
      return null
    },
    realpath: (candidate) => {
      return candidate
    },
    platform: 'darwin',
  }
}

const anEntry = (): InitEntry => {
  return { step: 'zshrc', outcome: 'written', message: 'Added infra-kit shell functions', level: 'info' }
}

beforeEach(() => {
  vi.mocked(initCore).mockImplementation(async (onStep?: InitStepSink) => {
    const entry = anEntry()

    onStep?.(entry)

    return [entry]
  })
})

const HOME = '/Users/ada'
const CWD = `${HOME}/work/app`
const EXEC_PATH = '/opt/node/24.21.0/bin/node'
const TARGET = '/store/infra-kit@0.5.6/node_modules/portless'
const BIN = `${TARGET}/dist/cli.js`

const DRIFTED_ARGV1 =
  '/Users/ada/Library/pnpm/global/v11/8a83-1/node_modules/.pnpm/infra-kit@0.5.5/node_modules/portless/dist/cli.js'

interface Fixture {
  /** The link's own fake tree — what `ensurePortlessLink` converges. */
  linkFs?: Record<string, LinkEntry>
  home?: string
  platform?: NodeJS.Platform
  /** The installed service file's text; absent = the service is not installed. */
  serviceFile?: string
  /** Whether `<link>/dist/cli.js` resolves — the link's health as the verdict sees it. Default: yes. */
  linkResolves?: boolean
  /** Whether the node the service names is still on disk. Default: yes. */
  nodeExists?: boolean
}

/** Builds a `PortlessServiceDeps` from a small fixture, so each test states only what differs. */
const portlessDeps = (fixture: Fixture): PortlessServiceDeps => {
  const home = fixture.home ?? HOME
  const linkCli = path.join(home, '.infra-kit', 'portless', 'dist', 'cli.js')
  const link: EnsurePortlessLinkDeps = {
    resolveBin: () => {
      return BIN
    },
    isGlobal: () => {
      return true
    },
    home,
    fs: fakeLinkFs(fixture.linkFs),
  }

  return {
    link,
    target: {
      platform: fixture.platform ?? 'darwin',
      readServiceFile: () => {
        return fixture.serviceFile ?? null
      },
      readFile: () => {
        return null
      },
      exists: (candidate) => {
        if (candidate === EXEC_PATH) return fixture.nodeExists ?? true
        if (candidate === linkCli) return fixture.linkResolves ?? true

        return false
      },
      realpath: (candidate) => {
        return candidate.startsWith(path.join(home, '.infra-kit', 'portless'))
          ? TARGET + candidate.slice(path.join(home, '.infra-kit', 'portless').length)
          : candidate
      },
      mtime: () => {
        return null
      },
      execPath: EXEC_PATH,
      home,
      cwd: CWD,
      repoRoot: () => {
        return Promise.resolve(CWD)
      },
      stateDir: () => {
        return `${home}/.portless`
      },
      processStartTime: () => {
        return null
      },
    },
  }
}

const HOME_LINK = `${HOME}/.infra-kit/portless`
const HOME_LINK_CLI = `${HOME_LINK}/dist/cli.js`

const infoLines = (): string[] => {
  return vi.mocked(logger.info).mock.calls.map((call) => {
    return typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0])
  })
}

const portlessSudoLines = (): string[] => {
  return infoLines().filter((line) => {
    return line.includes('service install')
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('setup converges the portless link and prints the sudo line only on drift', () => {
  // AC(a): fresh machine — no service installed at all, and the link has just been created.
  it('prints exactly one portless sudo line through the link, on a fresh machine', async () => {
    await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({ linkFs: {} }),
    })

    const lines = portlessSudoLines()

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('/.infra-kit/portless/dist/cli.js')
    expect(lines[0]).toMatch(/^\s*sudo /)
  })

  // AC(b): converged — the plist is already installed and its argv already IS the current node + the stable link.
  it('prints no portless sudo line, and reports the link step as unchanged, when converged', async () => {
    const infoCallsBefore = vi.mocked(logger.info).mock.calls.length

    await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
        serviceFile: launchdPlist([EXEC_PATH, HOME_LINK_CLI, 'proxy', '--port', '443']),
      }),
    })

    expect(portlessSudoLines()).toHaveLength(0)

    const newLines = vi
      .mocked(logger.info)
      .mock.calls.slice(infoCallsBefore)
      .map((call) => {
        return String(call[0])
      })

    expect(newLines).toContainEqual(expect.stringContaining('unchanged'))
  })

  // AC(c): the plist is installed, but its argv[1] is still a version-specific pnpm store path.
  it('prints the sudo line when the installed service still points at a version-specific path', async () => {
    await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
        serviceFile: launchdPlist([EXEC_PATH, DRIFTED_ARGV1, 'proxy']),
      }),
    })

    const lines = portlessSudoLines()

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('/.infra-kit/portless/dist/cli.js')
  })

  // The plist already goes through the link, but names a node that was since removed: launchd cannot start
  // the daemon at the next boot. An argv[1]-only comparison called this converged and printed nothing.
  it('prints the sudo line when the link-based plist names a node that no longer exists', async () => {
    await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
        serviceFile: launchdPlist(['/Users/ada/Library/pnpm/nodejs/24.18.0/bin/node', HOME_LINK_CLI, 'proxy']),
        nodeExists: false,
      }),
    })

    const lines = portlessSudoLines()

    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(`  sudo ${EXEC_PATH} ${HOME_LINK_CLI} service install`)
  })

  // systemd quotes every ExecStart word; a naive whitespace split of a path with a space compared the
  // wrong word and printed the sudo line on every run of a converged Linux machine.
  it('reads a quoted ExecStart path containing a space as the link, and prints nothing (linux)', async () => {
    const home = '/home/ada m'
    const linkCli = path.join(home, '.infra-kit', 'portless', 'dist', 'cli.js')

    await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        home,
        platform: 'linux',
        linkFs: { [path.join(home, '.infra-kit', 'portless')]: { kind: 'symlink', target: TARGET } },
        serviceFile: systemdUnit([EXEC_PATH, linkCli, 'proxy', '--port', '443']),
      }),
    })

    expect(portlessSudoLines()).toHaveLength(0)
  })

  // A path holding the literal text `&quot;` is written as `&amp;quot;`; unescaping `&amp;` FIRST turns that
  // into `"` and the comparison misses the link. Doctor's reader unescapes it last, and setup now shares it.
  it('round-trips a plist path holding `&amp;quot;` without double-unescaping it', async () => {
    const home = '/Users/r&quot;d'
    const linkCli = path.join(home, '.infra-kit', 'portless', 'dist', 'cli.js')
    const plist = launchdPlist([EXEC_PATH, linkCli, 'proxy'])

    expect(plist).toContain('&amp;quot;')

    await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        home,
        linkFs: { [path.join(home, '.infra-kit', 'portless')]: { kind: 'symlink', target: TARGET } },
        serviceFile: plist,
      }),
    })

    expect(portlessSudoLines()).toHaveLength(0)
  })

  it('never runs sudo itself — runRecipe is the only executor, and it never sees "service install"', async () => {
    await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({ linkFs: {} }),
    })

    const handedArgv = vi.mocked(runRecipe).mock.calls.flatMap((call) => {
      return call[0].steps.map((step) => {
        return step.join(' ')
      })
    })

    expect(
      handedArgv.some((line) => {
        return line.includes('service install')
      }),
    ).toBe(false)
  })

  it('throws InitStepError from the init half and still converges the portless link', async () => {
    vi.mocked(initCore).mockRejectedValue(new InitStepError('zshrc', new Error('EACCES')))

    await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({ linkFs: {} }),
    })

    expect(portlessSudoLines()).toHaveLength(1)
  })
})
