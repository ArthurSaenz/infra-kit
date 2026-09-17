import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

import { fakeNodeFs, fileEntry, hardlinkNodeFs, sidecarFor } from 'src/dev/proxy/__tests__/portless-link-fixtures'
import type { FakeNodeFs, NodeEntry } from 'src/dev/proxy/__tests__/portless-link-fixtures'
import type { PortlessNodeSidecar } from 'src/dev/proxy/portless-node'

import { checkPortless } from '../doctor'
import type { CheckResult, NodeVersionProbe, PortlessCheckDeps } from '../doctor'

/**
 * One fixture per row of the plan's §5.5 N-table, driven through the `nodeFs` / `nodeVersionOf` /
 * `isGlobal` seams: no real `~/.infra-kit`, no real spawn. The verdict is observed two ways — the row
 * itself, and the `service install` line the `:443` row renders, which is the only witness of what
 * `stableNode` resolved to (a string renders through the stable node, `null` through `execPath`).
 */

const HOME = '/Users/x'
const NODE = path.join(HOME, '.infra-kit', 'node')
const SIDECAR = `${NODE}.source.json`
const EXEC_PATH = '/opt/pnpm/global/v11/abc-0/node_modules/node/bin/node'
/** The bin the checkout resolves; no link on this machine, so every install line ends in it. */
const BIN = '/Users/x/work/api/node_modules/portless/dist/cli.js'
const EXEC_SIZE = 122_129_232

const sidecarEntry = (overrides: Partial<PortlessNodeSidecar> = {}): NodeEntry => {
  return sidecarFor(EXEC_PATH, overrides)
}

/** The N8 hardlink shape: one inode under both names. */
const hardlinkFs = (sidecar: Partial<PortlessNodeSidecar> = {}): FakeNodeFs => {
  return hardlinkNodeFs({ home: HOME, execPath: EXEC_PATH, size: EXEC_SIZE, sidecar })
}

/** The copy shape: two inodes, the sidecar recording the source's size. */
const copyFs = (sidecar: NodeEntry = sidecarEntry({ method: 'copy', sourceSize: EXEC_SIZE })): FakeNodeFs => {
  return fakeNodeFs({
    [EXEC_PATH]: fileEntry({ ino: 7, dev: 1, size: EXEC_SIZE }),
    [NODE]: fileEntry({ ino: 8, dev: 1, size: EXEC_SIZE }),
    [SIDECAR]: sidecar,
  })
}

const RUNS_CURRENT: NodeVersionProbe = { version: process.version, status: 0, signal: null }

interface Machine {
  nodeFs: FakeNodeFs
  nodeVersionOf?: (node: string) => NodeVersionProbe
  isGlobal?: boolean
  platform?: NodeJS.Platform
  /** Observed call order — the seams push their name here so a test can assert the node row ran first. */
  order?: string[]
}

const depsFor = (machine: Machine): PortlessCheckDeps => {
  return {
    resolveBin: () => {
      return BIN
    },
    isProxyServing: () => {
      machine.order?.push('isProxyServing')

      return Promise.resolve(false)
    },
    handshake: () => {
      return Promise.resolve({ ok: true })
    },
    caTrusted: () => {
      return true
    },
    routes: () => {
      return []
    },
    isListening: () => {
      return Promise.resolve(true)
    },
    caPath: () => {
      return '/nowhere/ca.pem'
    },
    platform: machine.platform ?? 'darwin',
    readServiceFile: () => {
      return null
    },
    exists: () => {
      return false
    },
    execPath: EXEC_PATH,
    home: HOME,
    isGlobal: () => {
      return machine.isGlobal ?? true
    },
    nodeFs: machine.nodeFs,
    nodeVersionOf:
      machine.nodeVersionOf ??
      (() => {
        throw new Error('nodeVersionOf must not be spawned on this path')
      }),
  }
}

const run = async (machine: Machine): Promise<{ node: CheckResult; installLine: string; checks: CheckResult[] }> => {
  const checks = await checkPortless(depsFor(machine))
  const node = checks.find((check) => {
    return check.name === 'portless node'
  })
  const serving = checks.find((check) => {
    return check.name.startsWith('portless serving TLS')
  })
  const installLine = /`(sudo [^`]+ service install)`/.exec(serving?.message ?? '')?.[1]

  if (node === undefined || installLine === undefined) throw new Error('missing node row or install line')

  return { node, installLine, checks }
}

const THROUGH_STABLE = `sudo ${NODE} ${BIN} service install`
const THROUGH_EXEC = `sudo ${EXEC_PATH} ${BIN} service install`

describe('portless node', () => {
  it('n1: skips on a platform with no OS service, and renders through execPath', async () => {
    const { node, installLine } = await run({ nodeFs: hardlinkFs(), platform: 'win32' })

    expect(node).toEqual({
      name: 'portless node',
      status: 'pass',
      message: 'Skipped — no portless OS service on this platform',
    })
    expect(installLine).toBe(THROUGH_EXEC)
  })

  it('n2: from a checkout the ROW is a skip, but stableNode is still resolved so the printed line is the short one', async () => {
    const { node, installLine } = await run({ nodeFs: hardlinkFs(), isGlobal: false })

    expect(node).toEqual({
      name: 'portless node',
      status: 'pass',
      message: 'Skipped — not a global install; the global infra-kit keeps ~/.infra-kit/node current',
    })
    expect(installLine).toBe(THROUGH_STABLE)
  })

  it('n2 from a checkout with no file: the skip row, and the deep execPath line', async () => {
    const { node, installLine } = await run({ nodeFs: fakeNodeFs(), isGlobal: false })

    expect(node.status).toBe('pass')
    expect(node.message).toMatch(/^Skipped — not a global install/)
    expect(installLine).toBe(THROUGH_EXEC)
  })

  it('n3: fails when nothing is at the path — the boot hook ran in this process, so absence is a failed write', async () => {
    const { node, installLine } = await run({ nodeFs: fakeNodeFs() })

    expect(node).toEqual({
      name: 'portless node',
      status: 'fail',
      message: '~/.infra-kit/node is missing and could not be written — run `infra-kit setup` and see the debug log',
    })
    expect(installLine).toBe(THROUGH_EXEC)
  })

  it.each([
    ['a symlink', { kind: 'symlink' } as NodeEntry],
    ['a directory', { kind: 'dir' } as NodeEntry],
  ])('n4: fails on %s at the path and says it will not be replaced', async (_, entry) => {
    const { node, installLine } = await run({
      nodeFs: fakeNodeFs({ [EXEC_PATH]: fileEntry({ size: EXEC_SIZE }), [NODE]: entry, [SIDECAR]: sidecarEntry() }),
    })

    expect(node).toEqual({
      name: 'portless node',
      status: 'fail',
      message:
        '~/.infra-kit/node is not a regular file; infra-kit will not replace it — move it away and run `infra-kit setup`',
    })
    expect(installLine).toBe(THROUGH_EXEC)
  })

  it.each([
    ['missing', undefined],
    ['corrupt JSON', fileEntry({ content: '{ "method": "hardlink", ' })],
    ['a parse failure', fileEntry({ content: JSON.stringify({ method: 'tarball', version: 'v1' }) })],
  ])('n5: a regular file whose sidecar is %s gets its own message — never "Node undefined"', async (_, sidecar) => {
    const node = fileEntry({ ino: 7, dev: 1, size: EXEC_SIZE })
    const { node: row, installLine } = await run({
      nodeFs: fakeNodeFs({ [EXEC_PATH]: node, [NODE]: node, ...(sidecar === undefined ? {} : { [SIDECAR]: sidecar }) }),
    })

    expect(row).toEqual({
      name: 'portless node',
      status: 'fail',
      message:
        '~/.infra-kit/node has no readable node.source.json and it could not be rewritten — run `infra-kit setup`',
    })
    expect(row.message).not.toContain('undefined')
    expect(installLine).toBe(THROUGH_EXEC)
  })

  it('n6: a hardlink on a different inode (a re-mint whose relink failed) — same version string, "a different file"', async () => {
    const { node, installLine } = await run({
      nodeFs: fakeNodeFs({
        [EXEC_PATH]: fileEntry({ ino: 7, dev: 1, size: EXEC_SIZE }),
        [NODE]: fileEntry({ ino: 6, dev: 1, size: EXEC_SIZE }),
        [SIDECAR]: sidecarEntry({ source: '/opt/pnpm/global/v11/old-0/node_modules/node/bin/node' }),
      }),
    })

    expect(node).toEqual({
      name: 'portless node',
      status: 'fail',
      message: `~/.infra-kit/node is Node ${process.version} (hardlink of /opt/pnpm/global/v11/old-0/node_modules/node/bin/node); infra-kit runs ${process.version} at ${EXEC_PATH}, a different file, and could not relink it — run \`infra-kit setup\``,
    })
    expect(installLine).toBe(THROUGH_EXEC)
  })

  it.each<[string, Partial<PortlessNodeSidecar>]>([
    ['version', { version: 'v22.0.0' }],
    ['arch', { arch: 'x64-not-this' }],
    ['platform', { platform: 'freebsd' }],
  ])(
    'n6: a hardlink on the SAME inode whose sidecar differs on %s is stale (the crash-after-bump state)',
    async (_, patch) => {
      const { node, installLine } = await run({ nodeFs: hardlinkFs(patch) })

      expect(node.status).toBe('fail')
      expect(node.message).toContain(
        `~/.infra-kit/node is Node ${patch.version ?? process.version} (hardlink of ${EXEC_PATH})`,
      )
      expect(node.message).toContain(`infra-kit runs ${process.version} at ${EXEC_PATH}, a different file`)
      expect(installLine).toBe(THROUGH_EXEC)
    },
  )

  it("n6: a copy whose recorded sourceSize is not execPath's size is stale, without a spawn", async () => {
    const { node, installLine } = await run({
      nodeFs: copyFs(sidecarEntry({ method: 'copy', sourceSize: EXEC_SIZE - 1 })),
    })

    expect(node.status).toBe('fail')
    expect(node.message).toContain(
      `(copy of ${EXEC_PATH}); infra-kit runs ${process.version} at ${EXEC_PATH}, a different file`,
    )
    expect(installLine).toBe(THROUGH_EXEC)
  })

  it('n6: a copy whose sidecar records no sourceSize cannot be shown consistent — stale', async () => {
    const { node } = await run({ nodeFs: copyFs(sidecarEntry({ method: 'copy' })) })

    expect(node.status).toBe('fail')
    expect(node.message).toContain('a different file')
  })

  it.each<[string, NodeVersionProbe, string]>([
    [
      'killed by a signal (an AMFI/Gatekeeper kill has no status)',
      { version: null, status: null, signal: 'SIGKILL' },
      'killed by SIGKILL',
    ],
    ['a non-zero exit', { version: null, status: 126, signal: null }, 'exit 126'],
    ['a spawn that never started', { version: null, status: null, signal: null }, 'did not start'],
    ['the wrong version', { version: 'v22.0.0', status: 0, signal: null }, 'printed v22.0.0'],
  ])('n7: a consistent copy that does not run as this Node — %s', async (_, probe, reason) => {
    const spawned: string[] = []
    const { node, installLine } = await run({
      nodeFs: copyFs(),
      nodeVersionOf: (target) => {
        spawned.push(target)

        return probe
      },
    })

    expect(spawned).toEqual([NODE])
    expect(node).toEqual({
      name: 'portless node',
      status: 'fail',
      message: `~/.infra-kit/node does not run as Node ${process.version} (${reason}). Re-run through the current Node: \`${THROUGH_EXEC}\`, then \`infra-kit setup\``,
    })
    // `stableNode === null`: the remediation and every other row render through execPath.
    expect(installLine).toBe(THROUGH_EXEC)
  })

  it("n8: a hardlink of this process's inode passes WITHOUT a spawn, and stableNode is the file", async () => {
    const { node, installLine } = await run({ nodeFs: hardlinkFs() })

    expect(node).toEqual({
      name: 'portless node',
      status: 'pass',
      message: `~/.infra-kit/node is Node ${process.version} (${process.arch}, hardlink of ${EXEC_PATH})`,
    })
    expect(installLine).toBe(THROUGH_STABLE)
  })

  it('n8: a consistent copy that runs as this Node passes — the copy-path machine reaches the short line', async () => {
    const { node, installLine } = await run({
      nodeFs: copyFs(),
      nodeVersionOf: () => {
        return RUNS_CURRENT
      },
    })

    expect(node).toEqual({
      name: 'portless node',
      status: 'pass',
      message: `~/.infra-kit/node is Node ${process.version} (${process.arch}, copy of ${EXEC_PATH})`,
    })
    expect(installLine).toBe(THROUGH_STABLE)
  })

  it('never writes: the health check is read-only on every path', async () => {
    const machines = [hardlinkFs(), copyFs(), fakeNodeFs(), hardlinkFs({ version: 'v1.0.0' })]

    for (const nodeFs of machines) {
      await run({
        nodeFs,
        nodeVersionOf: () => {
          return RUNS_CURRENT
        },
      })
      expect(nodeFs.calls).toEqual([])
    }
  })

  it('runs the node row before the :443 row, and lists it right after `portless installed`', async () => {
    const order: string[] = []
    const nodeFs = hardlinkFs()
    const lstatSync = nodeFs.lstatSync

    nodeFs.lstatSync = (target, options) => {
      order.push('lstat')

      return lstatSync(target, options)
    }

    const { checks } = await run({ nodeFs, order })

    expect(order).toEqual(['lstat', 'isProxyServing'])
    expect(
      checks.slice(0, 3).map((check) => {
        return check.name
      }),
    ).toEqual(['portless installed', 'portless node', 'portless service target'])
  })
})
