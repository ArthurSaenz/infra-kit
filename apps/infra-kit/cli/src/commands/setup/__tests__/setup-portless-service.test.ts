import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { launchdPlist, systemdUnit } from 'src/commands/doctor/__tests__/service-fixtures'
import type { ServiceTargetDeps } from 'src/commands/doctor/doctor'
import { InitStepError, initCore } from 'src/commands/init'
import type { InitEntry, InitStepSink } from 'src/commands/init'
import { setup } from 'src/commands/setup'
import type { PortlessServiceDeps } from 'src/commands/setup'
import {
  expectRenameOnly,
  fakeLinkFs,
  fakeNodeFs,
  fileEntry,
  mutatingCalls,
  sidecarFor,
} from 'src/dev/proxy/__tests__/portless-link-fixtures'
import type { FakeNodeFs, LinkEntry, NodeEntry } from 'src/dev/proxy/__tests__/portless-link-fixtures'
import type { EnsurePortlessLinkDeps } from 'src/dev/proxy/portless-link'
import type { PortlessNodeSidecar } from 'src/dev/proxy/portless-node'
import { runRecipe } from 'src/lib/dependency-install'
import type { InstallOutcome } from 'src/lib/dependency-install'
import type { ProbeDeps } from 'src/lib/dependency-probe'
import { logger } from 'src/lib/logger'

/**
 * US-005: `setup` converges `~/.infra-kit/portless` and `~/.infra-kit/node` and, only when the installed
 * system service has not caught up to them, prints the ONE `service install` line a human has to run.
 * Everything is injected through {@link PortlessServiceDeps} (an in-memory `fs` for the link and one for
 * the node, a stubbed `nodeVersionOf`, doctor's own service-target seams for the verdict) — no real disk,
 * no real plist, no `ps`, no spawn, matching `portless-link.test.ts`'s discipline.
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
const EXEC_INO = 4242
const EXEC_SIZE = 134_000_000
/**
 * The process's own triple, not a literal: the target seams leave `version`/`arch` to doctor's defaults
 * (`process.*`), as production does, so the sidecar the node step writes must name this process.
 */
const NODE_VERSION = process.version
const NODE_ARCH = process.arch
const TARGET = '/store/infra-kit@0.5.6/node_modules/portless'
const BIN = `${TARGET}/dist/cli.js`

const DRIFTED_ARGV1 =
  '/Users/ada/Library/pnpm/global/v11/8a83-1/node_modules/.pnpm/infra-kit@0.5.5/node_modules/portless/dist/cli.js'
/** The plist word `service install` bakes in today: the package manager's node, gone at the next re-mint. */
const DEEP_NODE = '/Users/ada/Library/pnpm/global/v11/8a83-1/node_modules/.pnpm/node@runtime/bin/node'

/** The process's own inode: what a hardlink at `~/.infra-kit/node` shares. */
const execEntry = (): NodeEntry => {
  return fileEntry({ ino: EXEC_INO, dev: 1, size: EXEC_SIZE })
}

const sidecarEntry = (sidecar: Partial<PortlessNodeSidecar> = {}): NodeEntry => {
  return sidecarFor(EXEC_PATH, sidecar)
}

type NodeVersionOf = NonNullable<ServiceTargetDeps['nodeVersionOf']>

const runsAsThisNode: NodeVersionOf = () => {
  return { version: NODE_VERSION, status: 0, signal: null }
}

interface Fixture {
  /** The link's own fake tree — what `ensurePortlessLink` converges. */
  linkFs?: Record<string, LinkEntry>
  /** The node's fake tree beyond the process's own binary — what `ensurePortlessNode` converges. */
  nodeFs?: Record<string, NodeEntry>
  /** Whether this install is global (the gate of both converge steps). Default: yes. */
  isGlobal?: boolean
  /** The copy-path spawn. Default: runs as this Node — it is never reached on the hardlink path anyway. */
  nodeVersionOf?: NodeVersionOf
  home?: string
  platform?: NodeJS.Platform
  /** The installed service file's text; absent = the service is not installed. */
  serviceFile?: string
  /** Whether `<link>/dist/cli.js` resolves — the link's health as the verdict sees it. Default: yes. */
  linkResolves?: boolean
  /** The node the service file names, when it is a file the verdict should find on disk. Default: `EXEC_PATH`. */
  serviceNode?: string
  /** Whether the node the service names is still on disk. Default: yes. */
  nodeExists?: boolean
  /** What resolving the running portless finds; `null` = portless is not installed. Default: `BIN`. */
  resolvedBin?: string | null
}

/** Builds a `PortlessServiceDeps` from a small fixture, so each test states only what differs. */
const portlessDeps = (fixture: Fixture): PortlessServiceDeps & { nodeFs: FakeNodeFs } => {
  const home = fixture.home ?? HOME
  const linkCli = path.join(home, '.infra-kit', 'portless', 'dist', 'cli.js')
  const isGlobal = (): boolean => {
    return fixture.isGlobal ?? true
  }
  const link: EnsurePortlessLinkDeps = {
    resolveBin: () => {
      return fixture.resolvedBin === undefined ? BIN : fixture.resolvedBin
    },
    isGlobal,
    home,
    fs: fakeLinkFs(fixture.linkFs),
  }
  const nodeFs = fakeNodeFs({ [EXEC_PATH]: execEntry(), ...fixture.nodeFs })

  return {
    link,
    node: {
      isGlobal,
      home,
      execPath: EXEC_PATH,
      version: NODE_VERSION,
      arch: NODE_ARCH,
      platform: fixture.platform ?? 'darwin',
      fs: nodeFs,
    },
    nodeFs,
    target: {
      // Doctor's node row reads the SAME fake tree the converge step wrote, as production hands both the
      // real fs: the verdict and the printed line must never see two different nodes.
      nodeFs,
      nodeVersionOf: fixture.nodeVersionOf ?? runsAsThisNode,
      isGlobal,
      platform: fixture.platform ?? 'darwin',
      readServiceFile: () => {
        return fixture.serviceFile ?? null
      },
      readFile: () => {
        return null
      },
      exists: (candidate) => {
        if (candidate === (fixture.serviceNode ?? EXEC_PATH)) return fixture.nodeExists ?? true
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
const HOME_NODE = `${HOME}/.infra-kit/node`
const HOME_SIDECAR = `${HOME_NODE}.source.json`
/** The line every drifted verdict prints once the node is healthy: both words under `~/.infra-kit`, absolute, unquoted. */
const SHORT_LINE = `  sudo ${HOME_NODE} ${HOME_LINK_CLI} service install`
/** The fallback line — through the link, but under the node that provably runs. */
const EXEC_PATH_LINE = `  sudo ${EXEC_PATH} ${HOME_LINK_CLI} service install`
/** The payload's `command` is the printed line minus its indent: the same bytes a human copies. */
const SHORT_COMMAND = SHORT_LINE.trimStart()
const EXEC_PATH_COMMAND = EXEC_PATH_LINE.trimStart()

/** A machine whose node file is this process's inode and whose sidecar says so — doctor's N8, T8's argv[0]. */
const convergedNode = (): Record<string, NodeEntry> => {
  return { [HOME_NODE]: execEntry(), [HOME_SIDECAR]: sidecarEntry() }
}

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

/**
 * Every stderr line mentioning sudo. Callers run with `tools: []`: the brew refusal names `needs-sudo`,
 * and these tests are about the portless step alone.
 */
const sudoLines = (): string[] => {
  return infoLines().filter((line) => {
    return line.includes('sudo')
  })
}

const stepLines = (name: 'portless link' | 'portless node'): string[] => {
  return infoLines().filter((line) => {
    return line.includes(` ${name} — `)
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('setup converges the portless link and node and prints the sudo line only on drift', () => {
  // AC(a): fresh machine — no service installed at all, and both files have just been created. The line
  // is the SHORT one: `setup` resolved the node it just hardlinked as healthy (this process's inode), so
  // the word root will bake into the plist outlives every `pnpm add -g`.
  it('prints exactly one portless sudo line, through the link and the stable node, on a fresh machine', async () => {
    const deps = portlessDeps({ linkFs: {} })

    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), portlessDeps: deps })

    expect(structuredContent.portlessService).toEqual({
      link: 'created',
      node: 'created',
      service: 'absent',
      command: SHORT_COMMAND,
    })
    expect(portlessSudoLines()).toEqual([SHORT_LINE])
    expect(stepLines('portless link')).toEqual([expect.stringContaining('created   portless link — linked')])
    expect(stepLines('portless node')).toEqual([
      `  created   portless node — linked Node ${NODE_VERSION} to ~/.infra-kit/node`,
    ])
    expectRenameOnly(deps.nodeFs.calls, HOME_NODE)
  })

  // AC(b): converged — the plist already names the stable node and the stable link, and both files are
  // current. Two `unchanged` step lines, no sudo line, and no write to either file.
  it('prints no portless sudo line, and reports both steps as unchanged, when converged', async () => {
    const deps = portlessDeps({
      linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
      nodeFs: convergedNode(),
      serviceFile: launchdPlist([HOME_NODE, HOME_LINK_CLI, 'proxy', '--port', '443']),
      serviceNode: HOME_NODE,
    })

    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), portlessDeps: deps })

    expect(structuredContent.portlessService).toEqual({
      link: 'unchanged',
      node: 'unchanged',
      service: 'converged',
      command: null,
    })
    expect(portlessSudoLines()).toHaveLength(0)
    expect(stepLines('portless link')).toEqual([expect.stringContaining('unchanged portless link')])
    expect(stepLines('portless node')).toEqual([
      `  unchanged portless node — ~/.infra-kit/node is already Node ${NODE_VERSION}`,
    ])
    expect(mutatingCalls(deps.nodeFs.calls)).toEqual([])
  })

  // T5: the plist still names the package manager's node — the file `service install` bakes in from
  // `process.execPath`, gone at the next re-mint. The one re-run that switches it to the stable node.
  it('prints the short line when the installed service runs the package manager’s node (T5)', async () => {
    const { structuredContent } = await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
        nodeFs: convergedNode(),
        serviceFile: launchdPlist([DEEP_NODE, HOME_LINK_CLI, 'proxy', '--port', '443']),
        serviceNode: DEEP_NODE,
      }),
    })

    expect(portlessSudoLines()).toEqual([SHORT_LINE])
    expect(structuredContent.portlessService).toMatchObject({ service: 'drifted', command: SHORT_COMMAND })
  })

  // AC(c): the plist is installed, but its argv[1] is still a version-specific pnpm store path.
  it('prints the sudo line when the installed service still points at a version-specific path', async () => {
    const { structuredContent } = await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
        serviceFile: launchdPlist([EXEC_PATH, DRIFTED_ARGV1, 'proxy']),
      }),
    })

    expect(portlessSudoLines()).toEqual([SHORT_LINE])
    expect(structuredContent.portlessService).toMatchObject({ service: 'drifted', command: SHORT_COMMAND })
  })

  // The plist already goes through the link, but names a node that was since removed: launchd cannot start
  // the daemon at the next boot. An argv[1]-only comparison called this converged and printed nothing.
  it('prints the sudo line when the link-based plist names a node that no longer exists', async () => {
    const { structuredContent } = await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
        serviceFile: launchdPlist(['/Users/ada/Library/pnpm/nodejs/24.18.0/bin/node', HOME_LINK_CLI, 'proxy']),
        nodeExists: false,
      }),
    })

    expect(portlessSudoLines()).toEqual([SHORT_LINE])
    expect(structuredContent.portlessService).toMatchObject({ service: 'drifted', command: SHORT_COMMAND })
  })

  // The node step could not publish the file (a symlink squats on the path — the one thing the step
  // refuses to remove). Nothing healthy exists to hand to root, so the line is the deep one: runnable
  // today, and doctor's row says why it is not the short one.
  it('falls back to execPath when the node step failed', async () => {
    const deps = portlessDeps({
      linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
      nodeFs: { [HOME_NODE]: { kind: 'symlink' } },
    })

    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), portlessDeps: deps })

    expect(structuredContent.portlessService).toEqual({
      link: 'unchanged',
      node: 'failed',
      service: 'absent',
      command: EXEC_PATH_COMMAND,
    })

    expect(stepLines('portless node')).toEqual([
      '  failed    portless node — could not write ~/.infra-kit/node — see the debug log',
    ])
    expect(portlessSudoLines()).toEqual([EXEC_PATH_LINE])
    expect(mutatingCalls(deps.nodeFs.calls)).toEqual([])
  })

  // The copy path is the one where the inode proves nothing: a copy that does not start as this Node
  // (AMFI kill, wrong arch, truncated) must not be the word root runs. The spawn is the verdict.
  it('falls back to execPath when a copy of Node does not run as this Node', async () => {
    const copiedNode = (): Record<string, NodeEntry> => {
      return {
        [HOME_NODE]: fileEntry({ ino: 9001, dev: 1, size: EXEC_SIZE }),
        [HOME_SIDECAR]: sidecarEntry({ method: 'copy', sourceSize: EXEC_SIZE }),
      }
    }

    const { structuredContent } = await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
        nodeFs: copiedNode(),
        nodeVersionOf: () => {
          return { version: null, status: null, signal: 'SIGKILL' }
        },
      }),
    })

    expect(portlessSudoLines()).toEqual([EXEC_PATH_LINE])
    expect(structuredContent.portlessService).toMatchObject({ service: 'absent', command: EXEC_PATH_COMMAND })

    vi.clearAllMocks()

    const second = await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
        nodeFs: copiedNode(),
        nodeVersionOf: () => {
          return { version: null, status: null, signal: null }
        },
      }),
    })

    expect(portlessSudoLines()).toEqual([EXEC_PATH_LINE])
    expect(second.structuredContent.portlessService).toMatchObject({ service: 'absent', command: EXEC_PATH_COMMAND })
  })

  // One verdict feeds both the state and the printed line, so the copy is spawned ONCE per run.
  it('renders a consistent copy that runs as this Node through the stable node, spawning it once', async () => {
    const nodeVersionOf = vi.fn(runsAsThisNode)
    const deps = portlessDeps({
      linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
      nodeFs: {
        [HOME_NODE]: fileEntry({ ino: 9001, dev: 1, size: EXEC_SIZE }),
        [HOME_SIDECAR]: sidecarEntry({ method: 'copy', sourceSize: EXEC_SIZE }),
      },
      nodeVersionOf,
    })

    await setup({ probeDeps: nothingInstalled(), portlessDeps: deps })

    expect(stepLines('portless node')).toEqual([
      `  unchanged portless node — ~/.infra-kit/node is already Node ${NODE_VERSION}`,
    ])
    expect(portlessSudoLines()).toEqual([SHORT_LINE])
    expect(nodeVersionOf.mock.calls).toEqual([[HOME_NODE]])
  })

  // A checkout is never allowed near `~/.infra-kit/node`: the gate is the same `isGlobal` the link uses,
  // and the fake's call log is the witness that nothing was written. The candidate check still runs, so
  // the printed line is the deep one — runnable — rather than a file the checkout never made.
  it('skips the node step from a checkout, touching nothing, and prints the execPath line', async () => {
    const deps = portlessDeps({ linkFs: {}, isGlobal: false })

    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), portlessDeps: deps })

    expect(structuredContent.portlessService).toEqual({
      link: 'skipped-local',
      node: 'skipped-local',
      service: 'absent',
      command: EXEC_PATH_COMMAND,
    })

    expect(stepLines('portless node')).toEqual(['  skipped-local portless node — skipped — this install is not global'])
    expect(mutatingCalls(deps.nodeFs.calls)).toEqual([])
    expect(portlessSudoLines()).toEqual([EXEC_PATH_LINE])
  })

  // systemd quotes every ExecStart word; a naive whitespace split of a path with a space compared the
  // wrong word and printed the sudo line on every run of a converged Linux machine.
  it('reads a quoted ExecStart path containing a space as the link, and prints nothing (linux)', async () => {
    const home = '/home/ada m'
    const node = path.join(home, '.infra-kit', 'node')
    const linkCli = path.join(home, '.infra-kit', 'portless', 'dist', 'cli.js')

    const { structuredContent } = await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        home,
        platform: 'linux',
        linkFs: { [path.join(home, '.infra-kit', 'portless')]: { kind: 'symlink', target: TARGET } },
        nodeFs: { [node]: execEntry(), [`${node}.source.json`]: sidecarEntry({ platform: 'linux' }) },
        serviceFile: systemdUnit([node, linkCli, 'proxy', '--port', '443']),
        serviceNode: node,
      }),
    })

    expect(portlessSudoLines()).toHaveLength(0)
    expect(structuredContent.portlessService).toMatchObject({ service: 'converged', command: null })
  })

  // A path holding the literal text `&quot;` is written as `&amp;quot;`; unescaping `&amp;` FIRST turns that
  // into `"` and the comparison misses the link. Doctor's reader unescapes it last, and setup now shares it.
  it('round-trips a plist path holding `&amp;quot;` without double-unescaping it', async () => {
    const home = '/Users/r&quot;d'
    const node = path.join(home, '.infra-kit', 'node')
    const linkCli = path.join(home, '.infra-kit', 'portless', 'dist', 'cli.js')
    const plist = launchdPlist([node, linkCli, 'proxy'])

    expect(plist).toContain('&amp;quot;')

    const { structuredContent } = await setup({
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        home,
        linkFs: { [path.join(home, '.infra-kit', 'portless')]: { kind: 'symlink', target: TARGET } },
        nodeFs: { [node]: execEntry(), [`${node}.source.json`]: sidecarEntry() },
        serviceFile: plist,
        serviceNode: node,
      }),
    })

    expect(portlessSudoLines()).toHaveLength(0)
    expect(structuredContent.portlessService).toMatchObject({ service: 'converged', command: null })
  })

  // No portless anywhere: there is no binary to judge the service against, so the payload says so rather
  // than claiming a state, and no command is handed out.
  it('reports the service as skipped, with no command and no sudo line, when portless is not installed', async () => {
    const { structuredContent } = await setup({
      tools: [],
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({ linkFs: {}, resolvedBin: null, linkResolves: false }),
    })

    expect(structuredContent.portlessService).toEqual({
      link: 'skipped-unresolved',
      node: 'created',
      service: 'skipped',
      command: null,
    })
    expect(sudoLines()).toHaveLength(0)
  })

  // The payload's command must not be a second rendering beside the printed one.
  it('prints exactly one sudo line when the service is absent', async () => {
    const { structuredContent } = await setup({
      tools: [],
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({ linkFs: {} }),
    })

    expect(structuredContent.portlessService.service).toBe('absent')
    expect(sudoLines()).toEqual([SHORT_LINE])
  })

  it('prints exactly one sudo line when the service is drifted', async () => {
    const { structuredContent } = await setup({
      tools: [],
      probeDeps: nothingInstalled(),
      portlessDeps: portlessDeps({
        linkFs: { [HOME_LINK]: { kind: 'symlink', target: TARGET } },
        serviceFile: launchdPlist([EXEC_PATH, DRIFTED_ARGV1, 'proxy']),
      }),
    })

    expect(structuredContent.portlessService.service).toBe('drifted')
    expect(sudoLines()).toEqual([SHORT_LINE])
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
