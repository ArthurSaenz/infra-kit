import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

import { fakeNodeFs, hardlinkNodeFs } from 'src/dev/proxy/__tests__/portless-link-fixtures'
import type { FakeNodeFs } from 'src/dev/proxy/__tests__/portless-link-fixtures'
import { DARWIN_SERVICE_PLIST_PATH, LINUX_SERVICE_UNIT_PATH } from 'src/dev/proxy/portless-driver'
import type { HandshakeResult, PortlessRoute } from 'src/dev/proxy/portless-driver'

import { checkPortless } from '../doctor'
import type { CheckResult, PortlessCheckDeps } from '../doctor'
import { launchdPlist, systemdUnit } from './service-fixtures'

/**
 * One fixture per row of the plan's §5.5 table, driven entirely through seams: no real disk, no real
 * `ps`, no real `~/.infra-kit`. The service file is what portless's own writer would emit for the argv
 * under test (`service-fixtures.ts`), so the reader is exercised on real bytes, not on a shape the test
 * author guessed.
 */

const HOME = '/Users/x'
const CWD = '/Users/x/work/api'
const LINK = path.join(HOME, '.infra-kit', 'portless')
const LINK_CLI = path.join(LINK, 'dist', 'cli.js')
/** Where the link points on a converged machine — the pnpm-global layout, outside any checkout. */
const GLOBAL_TARGET = '/Users/x/Library/pnpm/global/v11/abc-0/node_modules/.pnpm/portless@1.2.3/node_modules/portless'
/** The bundled bin the driver would resolve when run from a checkout — the version-specific path. */
const CHECKOUT_BIN = '/Users/x/work/api/node_modules/portless/dist/cli.js'
const EXEC_PATH = '/opt/node/24.21.0/bin/node'
const OLD_NODE = '/opt/node/24.18.0/bin/node'
const STABLE_NODE = path.join(HOME, '.infra-kit', 'node')
/** The two sidecar clocks on a converged machine: the Node changed once, the file was re-minted later. */
const VERSION_CHANGED_AT = '2026-09-01T00:00:00.000Z'
const REFRESHED_AT = '2026-09-10T00:00:00.000Z'

/** The N8 shape under `HOME`, so the service-target row sees a HEALTHY `stableNode`; the clocks are the T7 tests' reference points. */
const stableNodeFs = (home = HOME, platform = 'darwin'): FakeNodeFs => {
  return hardlinkNodeFs({
    home,
    execPath: EXEC_PATH,
    sidecar: { platform, refreshedAt: REFRESHED_AT, versionChangedAt: VERSION_CHANGED_AT },
  })
}

const PACKAGE_JSON = JSON.stringify({ name: 'portless', version: '1.2.3' })

/**
 * A fake machine: which paths exist, what each file holds, where the link points, when the daemon
 * started. `files` doubles as the existence oracle — `exists` answers for the node binary and for the
 * `dist/cli.js` behind the link by resolving the path first, as the real `existsSync` would.
 */
interface Machine {
  platform?: NodeJS.Platform
  files: Record<string, string>
  /** Symlink resolution — `realpath` maps a prefix to its target; everything else is identity. */
  linkTarget?: string | null
  cwd?: string
  /** The git toplevel of `cwd`; `null` (the default) is "not in a repo", so the cwd itself is the root. */
  repoRoot?: string | null
  execPath?: string
  daemonStartedAt?: Date | null
  packageJsonMtime?: Date | null
  /** The fs behind `~/.infra-kit/node`; empty (no file → `stableNode: null`) unless a case is about the node. */
  nodeFs?: FakeNodeFs
}

const depsFor = (machine: Machine): PortlessCheckDeps => {
  const { files } = machine
  const realpath = (target: string): string => {
    if (machine.linkTarget == null) return target
    if (target === LINK) return machine.linkTarget
    if (target.startsWith(`${LINK}/`)) return machine.linkTarget + target.slice(LINK.length)

    return target
  }

  return {
    resolveBin: () => {
      return CHECKOUT_BIN
    },
    isProxyServing: () => {
      return Promise.resolve(true)
    },
    handshake: () => {
      return Promise.resolve<HandshakeResult>({ ok: true })
    },
    caTrusted: () => {
      return true
    },
    routes: (): PortlessRoute[] => {
      return []
    },
    isListening: () => {
      return Promise.resolve(true)
    },
    caPath: () => {
      return '/nowhere/ca.pem'
    },
    platform: machine.platform ?? 'darwin',
    readServiceFile: (filePath) => {
      return files[filePath] ?? null
    },
    readFile: (filePath) => {
      return files[realpath(filePath)] ?? null
    },
    exists: (target) => {
      return realpath(target) in files
    },
    realpath,
    mtime: () => {
      return machine.packageJsonMtime ?? null
    },
    execPath: machine.execPath ?? EXEC_PATH,
    home: HOME,
    cwd: machine.cwd ?? CWD,
    repoRoot: () => {
      return Promise.resolve(machine.repoRoot ?? null)
    },
    stateDir: () => {
      return '/Users/x/.portless'
    },
    processStartTime: () => {
      return machine.daemonStartedAt ?? null
    },
    isGlobal: () => {
      return true
    },
    nodeFs: machine.nodeFs ?? fakeNodeFs(),
    nodeVersionOf: () => {
      return { version: process.version, status: 0, signal: null }
    },
  }
}

const serviceTargetRow = async (machine: Machine): Promise<CheckResult> => {
  const checks = await checkPortless(depsFor(machine))
  const row = checks.find((check) => {
    return check.name === 'portless service target'
  })

  if (row === undefined) throw new Error('no service target row')

  return row
}

/** A converged machine: plist through the link, link → the global portless, current node, daemon fresh. */
const converged = (overrides: Partial<Machine> = {}): Machine => {
  return {
    files: {
      [DARWIN_SERVICE_PLIST_PATH]: launchdPlist([EXEC_PATH, LINK_CLI, 'proxy', '--port', '443']),
      [EXEC_PATH]: 'ELF',
      [path.join(GLOBAL_TARGET, 'dist', 'cli.js')]: 'js',
      [path.join(GLOBAL_TARGET, 'package.json')]: PACKAGE_JSON,
    },
    linkTarget: GLOBAL_TARGET,
    ...overrides,
  }
}

const INSTALL_THROUGH_LINK = `sudo ${EXEC_PATH} ${LINK_CLI} service install`

describe('portless service target', () => {
  it('skips (as a pass) when the OS service is not installed', async () => {
    const row = await serviceTargetRow({ files: {} })

    expect(row.status).toBe('pass')
    expect(row.message).toMatch(/^Skipped — the OS service is not installed/)
    expect(row.message).toContain(DARWIN_SERVICE_PLIST_PATH)
  })

  it('skips on a platform portless writes no plist or unit for', async () => {
    const row = await serviceTargetRow({ ...converged(), platform: 'win32' })

    expect(row.status).toBe('pass')
    expect(row.message).toMatch(/^Skipped — no portless OS service file on this platform/)
  })

  it('fails when the service runs a node that no longer exists, and prints the reinstall through the link', async () => {
    const machine = converged()

    machine.files[DARWIN_SERVICE_PLIST_PATH] = launchdPlist([OLD_NODE, LINK_CLI, 'proxy'])

    const row = await serviceTargetRow(machine)

    expect(row.status).toBe('fail')
    expect(row.message).toContain(
      `The service runs \`${OLD_NODE}\`, which no longer exists (Node was upgraded, or its package dir was re-created). Re-run: \`${INSTALL_THROUGH_LINK}\``,
    )
  })

  it('warns when the service runs an older node that still exists', async () => {
    const machine = converged()

    machine.files[DARWIN_SERVICE_PLIST_PATH] = launchdPlist([OLD_NODE, LINK_CLI, 'proxy'])
    machine.files[OLD_NODE] = 'ELF'

    const row = await serviceTargetRow(machine)

    expect(row.status).toBe('pass')
    expect(row.message).toBe(
      `Warning — The service runs \`${OLD_NODE}\`; infra-kit runs \`${EXEC_PATH}\`. Works until the old Node is removed. Re-run when convenient: \`${INSTALL_THROUGH_LINK}\``,
    )
  })

  it('warns when the script is a version-specific path, naming the link-based command to switch', async () => {
    const versioned = '/Users/x/Library/pnpm/global/v11/old-0/node_modules/portless/dist/cli.js'
    const machine = converged()

    machine.files[DARWIN_SERVICE_PLIST_PATH] = launchdPlist([EXEC_PATH, versioned, 'proxy'])

    const row = await serviceTargetRow(machine)

    expect(row.status).toBe('pass')
    expect(row.message).toContain(`Warning — The service points at \`${versioned}\`, a version-specific location`)
    expect(row.message).toContain(INSTALL_THROUGH_LINK)
  })

  it('renders the version-specific warning with the REAL bin when no link exists yet', async () => {
    const machine = converged({ linkTarget: null })

    machine.files[DARWIN_SERVICE_PLIST_PATH] = launchdPlist([EXEC_PATH, CHECKOUT_BIN, 'proxy'])

    const row = await serviceTargetRow(machine)

    expect(row.status).toBe('pass')
    expect(row.message).toContain(`sudo ${EXEC_PATH} ${CHECKOUT_BIN} service install`)
    expect(row.message).not.toContain(LINK_CLI)
  })

  it('fails when the service points at the link but the link is dangling', async () => {
    // The link resolves to a directory that holds no dist/cli.js — what a deleted pnpm-global project looks like.
    const row = await serviceTargetRow(converged({ linkTarget: '/Users/x/Library/pnpm/global/v11/gone-0/portless' }))

    expect(row.status).toBe('fail')
    expect(row.message).toBe(
      '~/.infra-kit/portless is broken. Run any infra-kit command from the global install (e.g. `infra-kit setup`) to repair it.',
    )
  })

  it('fails when the link is entirely absent', async () => {
    const row = await serviceTargetRow(converged({ linkTarget: null }))

    expect(row.status).toBe('fail')
    expect(row.message).toContain('~/.infra-kit/portless is broken')
  })

  it('fails when the link points inside the repo doctor is run from', async () => {
    const localTarget = path.join(CWD, 'node_modules', 'portless')
    const machine = converged({
      linkTarget: localTarget,
      files: {
        [DARWIN_SERVICE_PLIST_PATH]: launchdPlist([EXEC_PATH, LINK_CLI, 'proxy']),
        [EXEC_PATH]: 'ELF',
        [path.join(localTarget, 'dist', 'cli.js')]: 'js',
        [path.join(localTarget, 'package.json')]: PACKAGE_JSON,
      },
    })

    const row = await serviceTargetRow(machine)

    expect(row.status).toBe('fail')
    expect(row.message).toContain('The service runs portless from a project checkout')
    expect(row.message).toContain(INSTALL_THROUGH_LINK)
  })

  it('fails when the link points inside the REPO doctor is run from, even from a subdirectory of it', async () => {
    // From `<repo>/apps/x`, a link into `<repo>/node_modules/portless` is outside the cwd but inside the
    // checkout — and just as gone the day the worktree is removed.
    const repo = '/Users/x/work/mono'
    const localTarget = path.join(repo, 'node_modules', 'portless')
    const machine = converged({
      cwd: path.join(repo, 'apps', 'x'),
      repoRoot: repo,
      linkTarget: localTarget,
      files: {
        [DARWIN_SERVICE_PLIST_PATH]: launchdPlist([EXEC_PATH, LINK_CLI, 'proxy']),
        [EXEC_PATH]: 'ELF',
        [path.join(localTarget, 'dist', 'cli.js')]: 'js',
        [path.join(localTarget, 'package.json')]: PACKAGE_JSON,
      },
    })

    const row = await serviceTargetRow(machine)

    expect(row.status).toBe('fail')
    expect(row.message).toContain(`The service runs portless from a project checkout (${localTarget})`)
  })

  it('does not call the global target a checkout when doctor is run from $HOME', async () => {
    const row = await serviceTargetRow(converged({ cwd: HOME }))

    expect(row.status).toBe('pass')
    expect(row.message).not.toContain('Warning')
  })

  it('warns when the running daemon started before the link target was installed', async () => {
    const machine = converged({
      daemonStartedAt: new Date('2026-09-01T10:00:00Z'),
      packageJsonMtime: new Date('2026-09-02T10:00:00Z'),
    })

    machine.files['/Users/x/.portless/proxy.pid'] = '4242\n'

    const row = await serviceTargetRow(machine)

    expect(row.status).toBe('pass')
    expect(row.message).toBe(
      'Warning — The running daemon predates portless 1.2.3 that `dev` will talk to. Restart it: `sudo launchctl kickstart -k system/sh.portless.proxy` (or reboot).',
    )
  })

  it('names systemctl for the restart on linux', async () => {
    const machine: Machine = {
      platform: 'linux',
      files: {
        [LINUX_SERVICE_UNIT_PATH]: systemdUnit([EXEC_PATH, LINK_CLI, 'proxy', '--port', '443']),
        [EXEC_PATH]: 'ELF',
        [path.join(GLOBAL_TARGET, 'dist', 'cli.js')]: 'js',
        [path.join(GLOBAL_TARGET, 'package.json')]: PACKAGE_JSON,
        '/Users/x/.portless/proxy.pid': '4242',
      },
      linkTarget: GLOBAL_TARGET,
      daemonStartedAt: new Date('2026-09-01T10:00:00Z'),
      packageJsonMtime: new Date('2026-09-02T10:00:00Z'),
    }

    const row = await serviceTargetRow(machine)

    expect(row.message).toContain('`sudo systemctl restart portless`')
  })

  it('does NOT warn on the pid marker alone — an undatable pid, a missing pid file, or a missing mtime all fall through', async () => {
    const fresh = converged({
      daemonStartedAt: new Date('2026-09-03T10:00:00Z'),
      packageJsonMtime: new Date('2026-09-02T10:00:00Z'),
    })

    fresh.files['/Users/x/.portless/proxy.pid'] = '4242'
    expect((await serviceTargetRow(fresh)).message).not.toContain('Warning')

    const undatable = converged({ daemonStartedAt: null, packageJsonMtime: new Date('2026-09-02T10:00:00Z') })

    undatable.files['/Users/x/.portless/proxy.pid'] = '4242'
    expect((await serviceTargetRow(undatable)).message).not.toContain('Warning')

    const noPid = converged({
      daemonStartedAt: new Date('2026-09-01T10:00:00Z'),
      packageJsonMtime: new Date('2026-09-02T10:00:00Z'),
    })

    expect((await serviceTargetRow(noPid)).message).not.toContain('Warning')

    const garbagePid = converged({
      daemonStartedAt: new Date('2026-09-01T10:00:00Z'),
      packageJsonMtime: new Date('2026-09-02T10:00:00Z'),
    })

    garbagePid.files['/Users/x/.portless/proxy.pid'] = 'not-a-pid'
    expect((await serviceTargetRow(garbagePid)).message).not.toContain('Warning')
  })

  it('passes on a converged machine, naming the node and the portless version behind the link', async () => {
    const row = await serviceTargetRow(converged())

    expect(row).toEqual({
      name: 'portless service target',
      status: 'pass',
      message: `service runs \`${EXEC_PATH}\` (Node ${process.version}) + stable link → portless 1.2.3`,
    })
  })

  it("passes with version '?' when the link target's package.json is corrupt — a display value never aborts the report", async () => {
    const machine = converged()

    machine.files[path.join(GLOBAL_TARGET, 'package.json')] = '{"name": "portless", "version": '

    const row = await serviceTargetRow(machine)

    expect(row).toEqual({
      name: 'portless service target',
      status: 'pass',
      message: `service runs \`${EXEC_PATH}\` (Node ${process.version}) + stable link → portless ?`,
    })
  })

  it('reads the version-specific script from a plist whose ProgramArguments carry extra flags', async () => {
    const machine = converged()

    machine.files[DARWIN_SERVICE_PLIST_PATH] = launchdPlist([
      EXEC_PATH,
      LINK_CLI,
      'proxy',
      '--port',
      '443',
      '--tls',
      '--host',
      '127.0.0.1',
    ])

    expect((await serviceTargetRow(machine)).status).toBe('pass')
  })

  it('round-trips a link path containing `&` through the plist (`&amp;`)', async () => {
    const home = '/Users/r&d'
    const linkCli = path.join(home, '.infra-kit', 'portless', 'dist', 'cli.js')
    const target = '/Users/r&d/global/node_modules/portless'
    const deps = depsFor({
      files: {
        [DARWIN_SERVICE_PLIST_PATH]: launchdPlist([EXEC_PATH, linkCli, 'proxy']),
        [EXEC_PATH]: 'ELF',
        [path.join(target, 'dist', 'cli.js')]: 'js',
        [path.join(target, 'package.json')]: PACKAGE_JSON,
      },
    })
    const checks = await checkPortless({
      ...deps,
      home,
      cwd: '/Users/r&d/work',
      realpath: (p) => {
        return p.startsWith(`${home}/.infra-kit/portless`) ? target + p.slice(`${home}/.infra-kit/portless`.length) : p
      },
      exists: (p) => {
        return p === EXEC_PATH || p === path.join(target, 'dist', 'cli.js') || p === linkCli
      },
      readFile: (p) => {
        return p === path.join(target, 'package.json') ? PACKAGE_JSON : null
      },
    })
    const row = checks.find((check) => {
      return check.name === 'portless service target'
    })

    expect(row?.status).toBe('pass')
    expect(row?.message).toContain('portless 1.2.3')
  })

  it('warns "could not parse" on a malformed file instead of throwing', async () => {
    const row = await serviceTargetRow({ files: { [DARWIN_SERVICE_PLIST_PATH]: '<plist>garbage' } })

    expect(row.status).toBe('pass')
    expect(row.message).toContain(`Warning — could not parse ${DARWIN_SERVICE_PLIST_PATH}`)
  })
})

/**
 * The rows that exist because of `~/.infra-kit/node` (§5.5 T5–T8). `stableNodeFs()` makes the node row
 * N8, so `stableNode` is the string every remediation renders through; the plist under test names either
 * the deep `EXEC_PATH` (not yet switched) or the stable node (converged).
 */
describe('portless service target — stable node', () => {
  const INSTALL_THROUGH_STABLE_NODE = `sudo ${STABLE_NODE} ${LINK_CLI} service install`

  const stable = (overrides: Partial<Machine> = {}): Machine => {
    const machine = converged({ nodeFs: stableNodeFs(), ...overrides })

    machine.files[DARWIN_SERVICE_PLIST_PATH] = launchdPlist([STABLE_NODE, LINK_CLI, 'proxy', '--port', '443'])
    machine.files[STABLE_NODE] = 'ELF'

    return machine
  }

  it('t5: warns when the plist still names the deep node although the stable node is healthy, and renders the switch through it', async () => {
    const row = await serviceTargetRow(converged({ nodeFs: stableNodeFs() }))

    expect(row.status).toBe('pass')
    expect(row.message).toBe(
      `Warning — The service runs \`${EXEC_PATH}\`, a path its package manager will remove. Re-run once to switch it to the stable node: \`${INSTALL_THROUGH_STABLE_NODE}\``,
    )
  })

  it('t6: falls back to the execPath advisory and command when the node row failed (stableNode null)', async () => {
    const machine = converged()

    machine.files[DARWIN_SERVICE_PLIST_PATH] = launchdPlist([OLD_NODE, LINK_CLI, 'proxy'])
    machine.files[OLD_NODE] = 'ELF'

    const row = await serviceTargetRow(machine)

    expect(row.message).toBe(
      `Warning — The service runs \`${OLD_NODE}\`; infra-kit runs \`${EXEC_PATH}\`. Works until the old Node is removed. Re-run when convenient: \`${INSTALL_THROUGH_LINK}\``,
    )
  })

  it("t7: warns 'predates Node v…' when the daemon started before the sidecar's versionChangedAt", async () => {
    const machine = stable({
      daemonStartedAt: new Date('2026-08-30T00:00:00Z'),
      packageJsonMtime: new Date('2026-08-01T00:00:00Z'),
    })

    machine.files['/Users/x/.portless/proxy.pid'] = '4242'

    const row = await serviceTargetRow(machine)

    expect(row.message).toBe(
      `Warning — The running daemon predates Node ${process.version} that \`dev\` will talk to. Restart it: \`sudo launchctl kickstart -k system/sh.portless.proxy\` (or reboot).`,
    )
  })

  it('t7 reads versionChangedAt, never refreshedAt: a daemon started after the Node changed but before a same-version relink is current (T8)', async () => {
    const machine = stable({
      daemonStartedAt: new Date('2026-09-05T00:00:00Z'),
      packageJsonMtime: new Date('2026-08-01T00:00:00Z'),
    })

    machine.files['/Users/x/.portless/proxy.pid'] = '4242'

    const row = await serviceTargetRow(machine)

    expect(row.message).not.toContain('Warning')
    expect(row.message).toBe(`service runs \`${STABLE_NODE}\` (Node ${process.version}) + stable link → portless 1.2.3`)
  })

  it('t7 names both when the daemon predates the Node AND the link target', async () => {
    const machine = stable({
      daemonStartedAt: new Date('2026-08-30T00:00:00Z'),
      packageJsonMtime: new Date('2026-09-02T00:00:00Z'),
    })

    machine.files['/Users/x/.portless/proxy.pid'] = '4242'

    const row = await serviceTargetRow(machine)

    expect(row.message).toContain(`predates Node ${process.version} and portless 1.2.3 that`)
  })

  it('t7 names portless alone when only the link target is newer than the daemon', async () => {
    const machine = stable({
      daemonStartedAt: new Date('2026-09-01T12:00:00Z'),
      packageJsonMtime: new Date('2026-09-02T00:00:00Z'),
    })

    machine.files['/Users/x/.portless/proxy.pid'] = '4242'

    const row = await serviceTargetRow(machine)

    expect(row.message).toContain('predates portless 1.2.3 that')
    expect(row.message).not.toContain('Node')
  })

  it("t8: passes on a converged machine whose plist names the stable node, interpolating the plist's own path", async () => {
    const row = await serviceTargetRow(stable())

    expect(row).toEqual({
      name: 'portless service target',
      status: 'pass',
      message: `service runs \`${STABLE_NODE}\` (Node ${process.version}) + stable link → portless 1.2.3`,
    })
  })

  it('t8 on linux: a unit whose ExecStart runs the stable node passes', async () => {
    const home = '/home/u'
    const stableNode = path.join(home, '.infra-kit', 'node')
    const linkCli = path.join(home, '.infra-kit', 'portless', 'dist', 'cli.js')
    const target = '/home/u/.local/share/pnpm/global/5/node_modules/portless'
    const nodeFs = stableNodeFs(home, 'linux')
    const files = {
      [LINUX_SERVICE_UNIT_PATH]: systemdUnit([stableNode, linkCli, 'proxy', 'start', '--port', '443']),
      [stableNode]: 'ELF',
      [path.join(target, 'dist', 'cli.js')]: 'js',
      [path.join(target, 'package.json')]: PACKAGE_JSON,
    }
    const realpath = (p: string): string => {
      return p.startsWith(`${home}/.infra-kit/portless`) ? target + p.slice(`${home}/.infra-kit/portless`.length) : p
    }
    const checks = await checkPortless({
      ...depsFor({ platform: 'linux', files, nodeFs }),
      home,
      cwd: '/home/u/work',
      realpath,
      exists: (p) => {
        return realpath(p) in files
      },
      readFile: (p) => {
        return files[realpath(p)] ?? null
      },
    })
    const row = checks.find((check) => {
      return check.name === 'portless service target'
    })

    expect(row).toEqual({
      name: 'portless service target',
      status: 'pass',
      message: `service runs \`${stableNode}\` (Node ${process.version}) + stable link → portless 1.2.3`,
    })
  })
})

describe('installDaemonCmd', () => {
  const failingServing = (machine: Machine): PortlessCheckDeps => {
    return {
      ...depsFor(machine),
      isProxyServing: () => {
        return Promise.resolve(false)
      },
    }
  }

  const servingRow = async (deps: PortlessCheckDeps): Promise<CheckResult> => {
    const checks = await checkPortless(deps)
    const row = checks.find((check) => {
      return check.name.startsWith('portless serving TLS')
    })

    if (row === undefined) throw new Error('no serving row')

    return row
  }

  it('renders `service install` through the stable link when the link resolves', async () => {
    const row = await servingRow(failingServing(converged()))

    expect(row.message).toMatchInlineSnapshot(
      `"No portless daemon is serving HTTPS on :443. Install it once (needs root): \`sudo /opt/node/24.21.0/bin/node /Users/x/.infra-kit/portless/dist/cli.js service install\`."`,
    )
  })

  it('renders `service install` from the real bin when no link resolves', async () => {
    const row = await servingRow(failingServing(converged({ linkTarget: null })))

    expect(row.message).toMatchInlineSnapshot(
      `"No portless daemon is serving HTTPS on :443. Install it once (needs root): \`sudo /opt/node/24.21.0/bin/node /Users/x/work/api/node_modules/portless/dist/cli.js service install\`."`,
    )
  })
})
