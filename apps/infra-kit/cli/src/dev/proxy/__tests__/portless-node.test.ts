import fs from 'node:fs'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'

import {
  ensurePortlessNode,
  portlessNodePath,
  portlessNodeSidecar,
  readPortlessNodeSidecar,
  stableNodeCandidate,
} from 'src/dev/proxy/portless-node'
import type { EnsurePortlessNodeDeps, PortlessNodeResult, PortlessNodeSidecar } from 'src/dev/proxy/portless-node'

import { expectRenameOnly, fakeNodeFs, fileEntry, mutatingCalls } from './portless-link-fixtures'
import type { FakeNodeFs, NodeEntry } from './portless-link-fixtures'

const HOME = '/Users/ada'
const DIR = `${HOME}/.infra-kit`
const NODE = `${DIR}/node`
const SIDECAR = `${NODE}.source.json`
const TMP = `${NODE}.tmp-${process.pid}`
const SIDECAR_TMP = `${SIDECAR}.tmp-${process.pid}`
const EXEC = '/Users/ada/Library/pnpm/global/v11/60d8-1/node_modules/node/bin/node'
const EXEC_SIZE = 122_129_232
const COPY_FLAGS = fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL
const NOW = new Date('2026-09-17T09:24:11.000Z')
const EARLIER = '2026-09-13T18:02:40.000Z'
const LAST_REFRESH = '2026-09-16T08:00:00.000Z'

/** The running binary: the one entry every tree has. Its inode is what the fast path compares against. */
const exec = (): NodeEntry => {
  return fileEntry({ ino: 7, dev: 3, size: EXEC_SIZE })
}

const sidecarJson = (overrides: Partial<PortlessNodeSidecar> = {}): string => {
  return JSON.stringify({
    method: 'hardlink',
    version: 'v24.21.0',
    arch: 'arm64',
    platform: 'darwin',
    source: EXEC,
    refreshedAt: LAST_REFRESH,
    versionChangedAt: EARLIER,
    ...overrides,
  })
}

const sidecarEntry = (overrides: Partial<PortlessNodeSidecar> = {}): NodeEntry => {
  return fileEntry({ content: sidecarJson(overrides) })
}

const readSidecar = (nodeFs: FakeNodeFs): PortlessNodeSidecar => {
  const entry = nodeFs.tree.get(SIDECAR)

  if (entry?.kind !== 'file' || entry.content === undefined) throw new Error('no sidecar on disk')

  return JSON.parse(entry.content) as PortlessNodeSidecar
}

const deps = (nodeFs: FakeNodeFs, overrides: Partial<EnsurePortlessNodeDeps> = {}): EnsurePortlessNodeDeps => {
  return {
    isGlobal: () => {
      return true
    },
    home: HOME,
    execPath: EXEC,
    version: 'v24.21.0',
    arch: 'arm64',
    platform: 'darwin',
    fs: nodeFs,
    now: () => {
      return NOW
    },
    ...overrides,
  }
}

const result = (outcome: PortlessNodeResult['outcome'], method: PortlessNodeResult['method']): PortlessNodeResult => {
  return { kind: 'node', outcome, node: NODE, source: EXEC, version: 'v24.21.0', method }
}

/** The one publish sequence a hardlink refresh may produce, after `mkdir` + the orphan sweep's `readdir`. */
const HARDLINK_PUBLISH = [
  `link ${EXEC} -> ${TMP}`,
  `rename ${TMP} -> ${NODE}`,
  `writeFile ${SIDECAR_TMP}`,
  `rename ${SIDECAR_TMP} -> ${SIDECAR}`,
]

const expectHardlinkOf = (nodeFs: FakeNodeFs, source: NodeEntry): void => {
  // Same entry object: the fake's `linkSync` aliases, so identity IS "one inode, two names".
  expect(nodeFs.tree.get(NODE)).toBe(source)
}

describe('portlessNodePath / portlessNodeSidecar', () => {
  it('names the file and its sidecar under the shared user config dir', () => {
    expect(portlessNodePath('/Users/x')).toBe('/Users/x/.infra-kit/node')
    expect(portlessNodeSidecar('/Users/x')).toBe('/Users/x/.infra-kit/node.source.json')
  })
})

describe('ensurePortlessNode — first publish', () => {
  it('no file, no sidecar → created as a HARDLINK; mkdir, sweep, link, rename, sidecar tmp, rename — no chmod, no unlink', () => {
    const source = exec()
    const nodeFs = fakeNodeFs({ [EXEC]: source })

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('created', 'hardlink'))
    expect(nodeFs.calls).toEqual([`mkdir ${DIR}`, `readdir ${DIR}`, ...HARDLINK_PUBLISH])
    expectHardlinkOf(nodeFs, source)
    expect(readSidecar(nodeFs)).toEqual({
      method: 'hardlink',
      version: 'v24.21.0',
      arch: 'arm64',
      platform: 'darwin',
      source: EXEC,
      refreshedAt: NOW.toISOString(),
      versionChangedAt: NOW.toISOString(),
    })
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('the sidecar carries no sourceSize on the hardlink path — the inode is the witness there', () => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec() })

    ensurePortlessNode(deps(nodeFs))

    expect(readSidecar(nodeFs)).not.toHaveProperty('sourceSize')
  })
})

describe('ensurePortlessNode — the fast path', () => {
  it('same inode + a sidecar naming this Node → unchanged, with ZERO mutating calls', () => {
    const source = exec()
    const nodeFs = fakeNodeFs({ [EXEC]: source, [NODE]: source, [SIDECAR]: sidecarEntry() })

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('unchanged', 'hardlink'))
    expect(mutatingCalls(nodeFs.calls)).toEqual([])
    expect(readSidecar(nodeFs).refreshedAt).toBe(LAST_REFRESH)
  })

  it('same inode but NO sidecar → refreshed (still a hardlink), sidecar written with versionChangedAt = now', () => {
    const source = exec()
    const nodeFs = fakeNodeFs({ [EXEC]: source, [NODE]: source })

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('refreshed', 'hardlink'))
    expectHardlinkOf(nodeFs, source)
    expect(readSidecar(nodeFs).versionChangedAt).toBe(NOW.toISOString())
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('same inode but a corrupt sidecar → refreshed, sidecar rewritten', () => {
    const source = exec()
    const nodeFs = fakeNodeFs({ [EXEC]: source, [NODE]: source, [SIDECAR]: fileEntry({ content: '{ not json' }) })

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('refreshed')
    expect(readSidecar(nodeFs).method).toBe('hardlink')
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('same inode but the sidecar names another version (crash between the two renames after a bump) → refreshed, versionChangedAt = now', () => {
    const source = exec()
    const nodeFs = fakeNodeFs({ [EXEC]: source, [NODE]: source, [SIDECAR]: sidecarEntry({ version: 'v24.20.0' }) })

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('refreshed', 'hardlink'))
    expectHardlinkOf(nodeFs, source)
    expect(readSidecar(nodeFs)).toMatchObject({ version: 'v24.21.0', versionChangedAt: NOW.toISOString() })
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it.each([
    ['arch', { arch: 'x64' }],
    ['platform', { platform: 'linux' }],
  ])('same inode but the sidecar differs on %s → refreshed', (_, patch) => {
    const source = exec()
    const nodeFs = fakeNodeFs({ [EXEC]: source, [NODE]: source, [SIDECAR]: sidecarEntry(patch) })

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('refreshed')
    expectRenameOnly(nodeFs.calls, NODE)
  })
})

describe('ensurePortlessNode — relink and the two clocks', () => {
  it('different inode, SAME version triple (a pnpm re-mint) → refreshed; refreshedAt advances, versionChangedAt is carried over', () => {
    const source = exec()
    const stale = fileEntry({ ino: 99, dev: 3, size: EXEC_SIZE })
    const nodeFs = fakeNodeFs({ [EXEC]: source, [NODE]: stale, [SIDECAR]: sidecarEntry() })

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('refreshed', 'hardlink'))
    expect(nodeFs.calls).toEqual([`mkdir ${DIR}`, `readdir ${DIR}`, ...HARDLINK_PUBLISH])
    expectHardlinkOf(nodeFs, source)
    expect(readSidecar(nodeFs)).toMatchObject({ refreshedAt: NOW.toISOString(), versionChangedAt: EARLIER })
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('different inode AND a different version (a Node bump) → refreshed; both clocks advance', () => {
    const source = exec()
    const stale = fileEntry({ ino: 99, dev: 3, size: 1 })
    const nodeFs = fakeNodeFs({ [EXEC]: source, [NODE]: stale, [SIDECAR]: sidecarEntry({ version: 'v24.20.0' }) })

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('refreshed', 'hardlink'))
    expect(readSidecar(nodeFs)).toMatchObject({
      version: 'v24.21.0',
      refreshedAt: NOW.toISOString(),
      versionChangedAt: NOW.toISOString(),
    })
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('different inode, no parsable previous sidecar → versionChangedAt = now', () => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec(), [NODE]: fileEntry({ ino: 99, dev: 3 }) })

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('refreshed')
    expect(readSidecar(nodeFs).versionChangedAt).toBe(NOW.toISOString())
  })

  it('the old file is replaced by rename alone — never unlinked, never written through', () => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec(), [NODE]: fileEntry({ ino: 99, dev: 3 }), [SIDECAR]: sidecarEntry() })

    ensurePortlessNode(deps(nodeFs))

    expect(
      nodeFs.calls.filter((call) => {
        return call.startsWith('unlink')
      }),
    ).toEqual([])
    expectRenameOnly(nodeFs.calls, NODE)
  })
})

describe('ensurePortlessNode — the copy fallback', () => {
  const refusingLink = (error: unknown): Partial<FakeNodeFs> => {
    return {
      linkSync: () => {
        throw error
      },
    }
  }

  const withCode = (code: string): Error => {
    return Object.assign(new Error(`${code}: link refused`), { code })
  }

  it('linkSync throws EXDEV → the copy path: copyFile(FICLONE|EXCL) → chmod(tmp) → rename; sidecar has sourceSize', () => {
    const nodeFs = fakeNodeFs(
      { [EXEC]: exec(), [NODE]: fileEntry({ ino: 99, dev: 3 }) },
      refusingLink(withCode('EXDEV')),
    )

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('refreshed', 'copy'))
    expect(nodeFs.calls).toEqual([
      `mkdir ${DIR}`,
      `readdir ${DIR}`,
      `copyFile ${EXEC} -> ${TMP} ${COPY_FLAGS}`,
      `chmod ${TMP} 755`,
      `rename ${TMP} -> ${NODE}`,
      `writeFile ${SIDECAR_TMP}`,
      `rename ${SIDECAR_TMP} -> ${SIDECAR}`,
    ])
    expect(readSidecar(nodeFs)).toMatchObject({ method: 'copy', sourceSize: EXEC_SIZE })
    expect(nodeFs.tree.get(NODE)).not.toBe(nodeFs.tree.get(EXEC))
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it.each([
    ['EPERM (Linux protected_hardlinks, macOS cross-volume)', withCode('EPERM')],
    ['ENOTSUP (exFAT / SMB / NFS)', withCode('ENOTSUP')],
    ['EDEADLK (dataless iCloud file)', withCode('EDEADLK')],
    ['EACCES', withCode('EACCES')],
    ['EMLINK', withCode('EMLINK')],
    ['an error with no code at all', new Error('link failed for no named reason')],
    ['a non-Error throw', 'link failed'],
  ])('linkSync throwing %s → the copy path, every time', (_, error) => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec() }, refusingLink(error))

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('created', 'copy'))
    expect(nodeFs.calls).toContain(`copyFile ${EXEC} -> ${TMP} ${COPY_FLAGS}`)
    expect(nodeFs.calls).toContain(`chmod ${TMP} 755`)
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('chmod names the tmp sibling only — a chmod on the published name would mutate the shared inode', () => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec() }, refusingLink(withCode('EXDEV')))

    ensurePortlessNode(deps(nodeFs))

    expect(
      nodeFs.calls.filter((call) => {
        return call.startsWith('chmod')
      }),
    ).toEqual([`chmod ${TMP} 755`])
  })

  it('linkSync EACCES and copyFileSync EACCES → failed; the tmp is unlinked and nothing else is touched', () => {
    const stale = fileEntry({ ino: 99, dev: 3 })
    const nodeFs = fakeNodeFs(
      { [EXEC]: exec(), [NODE]: stale, [SIDECAR]: sidecarEntry() },
      {
        ...refusingLink(withCode('EACCES')),
        copyFileSync: () => {
          throw withCode('EACCES')
        },
      },
    )

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('failed', null))
    expect(nodeFs.calls.slice(2)).toEqual([`unlink ${TMP}`])
    expect(nodeFs.tree.get(NODE)).toBe(stale)
    expect(readSidecar(nodeFs).refreshedAt).toBe(LAST_REFRESH)
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('copyFileSync ENOSPC mid-way → failed; the partial tmp is unlinked, node file and sidecar untouched', () => {
    const stale = fileEntry({ ino: 99, dev: 3 })
    const nodeFs = fakeNodeFs(
      { [EXEC]: exec(), [NODE]: stale, [SIDECAR]: sidecarEntry() },
      {
        ...refusingLink(withCode('EXDEV')),
        copyFileSync: (_src, dest) => {
          nodeFs.tree.set(dest, fileEntry({ size: 1024 }))
          throw withCode('ENOSPC')
        },
      },
    )

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('failed')
    expect(nodeFs.tree.has(TMP)).toBe(false)
    expect(nodeFs.tree.get(NODE)).toBe(stale)
    expect(readSidecar(nodeFs).refreshedAt).toBe(LAST_REFRESH)
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('copy path, sidecar matching version/arch/platform AND sourceSize → unchanged, zero mutating calls', () => {
    const copy = fileEntry({ ino: 42, dev: 3, size: EXEC_SIZE })
    const nodeFs = fakeNodeFs({
      [EXEC]: exec(),
      [NODE]: copy,
      [SIDECAR]: sidecarEntry({ method: 'copy', sourceSize: EXEC_SIZE }),
    })

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('unchanged', 'copy'))
    expect(mutatingCalls(nodeFs.calls)).toEqual([])
  })

  it('copy path, same version but a different sourceSize (a different build) → refreshed', () => {
    const copy = fileEntry({ ino: 42, dev: 3, size: EXEC_SIZE })
    const nodeFs = fakeNodeFs({
      [EXEC]: exec(),
      [NODE]: copy,
      [SIDECAR]: sidecarEntry({ method: 'copy', sourceSize: EXEC_SIZE - 1 }),
    })

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('refreshed')
    expect(readSidecar(nodeFs).versionChangedAt).toBe(NOW.toISOString())
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('a hardlink → copy switch (the home moved volumes) with the same Node carries versionChangedAt over', () => {
    const nodeFs = fakeNodeFs(
      { [EXEC]: exec(), [NODE]: fileEntry({ ino: 99, dev: 3, size: EXEC_SIZE }), [SIDECAR]: sidecarEntry() },
      refusingLink(withCode('EXDEV')),
    )

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('refreshed', 'copy'))
    expect(readSidecar(nodeFs)).toMatchObject({
      method: 'copy',
      sourceSize: EXEC_SIZE,
      refreshedAt: NOW.toISOString(),
      versionChangedAt: EARLIER,
    })
    expectRenameOnly(nodeFs.calls, NODE)
  })
})

describe('ensurePortlessNode — failure containment', () => {
  it('the node rename throws → failed; the tmp link is unlinked, the old file and sidecar are untouched', () => {
    const stale = fileEntry({ ino: 99, dev: 3 })
    const nodeFs = fakeNodeFs({ [EXEC]: exec(), [NODE]: stale, [SIDECAR]: sidecarEntry() })

    nodeFs.renameSync = (from, to) => {
      nodeFs.calls.push(`rename ${from} -> ${to}`)
      throw new Error('EBUSY')
    }

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('failed', null))
    expect(nodeFs.calls.slice(2)).toEqual([`link ${EXEC} -> ${TMP}`, `rename ${TMP} -> ${NODE}`, `unlink ${TMP}`])
    expect(nodeFs.tree.get(NODE)).toBe(stale)
    expect(nodeFs.tree.has(TMP)).toBe(false)
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('the SIDECAR rename throws → failed, but the node file IS the new inode (a stale sidecar costs one extra refresh, never a wrong claim)', () => {
    const source = exec()
    const nodeFs = fakeNodeFs({ [EXEC]: source, [NODE]: fileEntry({ ino: 99, dev: 3 }), [SIDECAR]: sidecarEntry() })
    const realRename = nodeFs.renameSync

    nodeFs.renameSync = (from, to) => {
      if (to === SIDECAR) {
        nodeFs.calls.push(`rename ${from} -> ${to}`)
        throw new Error('EIO')
      }
      realRename(from, to)
    }

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('failed', null))
    expectHardlinkOf(nodeFs, source)
    expect(readSidecar(nodeFs).refreshedAt).toBe(LAST_REFRESH)
    expect(nodeFs.tree.has(SIDECAR_TMP)).toBe(false)
    expectRenameOnly(nodeFs.calls, NODE)

    // The next boot sees "inode equal, sidecar stale" and heals it in one refresh.
    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('unchanged')
  })

  it('mkdir throws → failed, nothing else attempted', () => {
    const nodeFs = fakeNodeFs(
      { [EXEC]: exec() },
      {
        mkdirSync: () => {
          throw new Error('EACCES')
        },
      },
    )

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('failed')
    expect(mutatingCalls(nodeFs.calls)).toEqual([])
  })

  it('never throws, whatever the seam does', () => {
    const nodeFs = fakeNodeFs(
      { [EXEC]: exec() },
      {
        lstatSync: () => {
          throw new Error('EIO')
        },
      },
    )

    expect(() => {
      return ensurePortlessNode(deps(nodeFs))
    }).not.toThrow()
    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('failed')
  })
})

describe('ensurePortlessNode — the orphan sweep', () => {
  it('unlinks node.tmp-* and node.source.json.tmp-* from crashed runs BEFORE linking, and nothing else', () => {
    const nodeFs = fakeNodeFs({
      [EXEC]: exec(),
      [`${NODE}.tmp-999`]: fileEntry(),
      [`${NODE}.tmp-1`]: fileEntry(),
      [`${SIDECAR}.tmp-7`]: fileEntry(),
      [`${DIR}/portless`]: { kind: 'symlink' },
      [`${DIR}/infra-kit.json`]: fileEntry(),
    })

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('created')

    const unlinks = nodeFs.calls.filter((call) => {
      return call.startsWith('unlink')
    })
    const linkAt = nodeFs.calls.findIndex((call) => {
      return call.startsWith('link')
    })

    expect(unlinks.sort()).toEqual([`unlink ${NODE}.tmp-1`, `unlink ${NODE}.tmp-999`, `unlink ${SIDECAR}.tmp-7`].sort())
    expect(nodeFs.calls.lastIndexOf(unlinks[0]!)).toBeLessThan(linkAt)
    expect(nodeFs.tree.has(`${DIR}/portless`)).toBe(true)
    expect(nodeFs.tree.has(`${DIR}/infra-kit.json`)).toBe(true)
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('a stale tmp under THIS pid (pid reuse after a crash) is swept, so linkSync does not hit EEXIST', () => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec(), [TMP]: fileEntry() })

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('created')
    expect(nodeFs.calls).toContain(`unlink ${TMP}`)
  })

  it('readdirSync throwing → the sweep is skipped and the link proceeds', () => {
    const nodeFs = fakeNodeFs(
      { [EXEC]: exec() },
      {
        readdirSync: () => {
          throw new Error('EACCES')
        },
      },
    )

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('created')
    expect(
      nodeFs.calls.filter((call) => {
        return call.startsWith('unlink')
      }),
    ).toEqual([])
    expect(nodeFs.calls).toContain(`link ${EXEC} -> ${TMP}`)
  })

  it('sweep skipped (readdir throws) AND a stale tmp under THIS pid is a hardlink of the live node → link EEXIST, copy refuses (EXCL), failed; the live inode is never opened for writing', () => {
    const live = exec()
    const nodeFs = fakeNodeFs(
      { [EXEC]: live, [TMP]: live },
      {
        readdirSync: () => {
          throw new Error('EACCES')
        },
      },
    )

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('failed')
    expect(nodeFs.calls).toContain(`copyFile ${EXEC} -> ${TMP} ${COPY_FLAGS}`)
    // The refused copy left the aliased entry as it was; only the failure-path unlink removed the NAME.
    expect(nodeFs.tree.get(EXEC)).toBe(live)
    expect(nodeFs.tree.get(EXEC)).toMatchObject({ kind: 'file', size: EXEC_SIZE })
    expect(nodeFs.tree.has(NODE)).toBe(false)
    expectRenameOnly(nodeFs.calls, NODE)
  })

  it('the sweep does not run on the fast path', () => {
    const source = exec()
    const nodeFs = fakeNodeFs({
      [EXEC]: source,
      [NODE]: source,
      [SIDECAR]: sidecarEntry(),
      [`${NODE}.tmp-999`]: fileEntry(),
    })

    expect(ensurePortlessNode(deps(nodeFs)).outcome).toBe('unchanged')
    expect(
      nodeFs.calls.filter((call) => {
        return call.startsWith('readdir')
      }),
    ).toEqual([])
    expect(nodeFs.tree.has(`${NODE}.tmp-999`)).toBe(true)
  })
})

describe('ensurePortlessNode — refusals and gates', () => {
  it('a SYMLINK at ~/.infra-kit/node → failed, left as found, zero mutating calls', () => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec(), [NODE]: { kind: 'symlink' } })

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('failed', null))
    expect(nodeFs.tree.get(NODE)).toEqual({ kind: 'symlink' })
    expect(mutatingCalls(nodeFs.calls)).toEqual([])
  })

  it('a DIRECTORY at ~/.infra-kit/node → failed, left as found, zero mutating calls', () => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec(), [NODE]: { kind: 'dir' } })

    expect(ensurePortlessNode(deps(nodeFs))).toEqual(result('failed', null))
    expect(nodeFs.tree.get(NODE)).toEqual({ kind: 'dir' })
    expect(mutatingCalls(nodeFs.calls)).toEqual([])
  })

  it('isGlobal() false → skipped-local, no fs call at all', () => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec() })

    expect(
      ensurePortlessNode(
        deps(nodeFs, {
          isGlobal: () => {
            return false
          },
        }),
      ),
    ).toEqual(result('skipped-local', null))
    expect(nodeFs.calls).toEqual([])
    expect(nodeFs.tree.size).toBe(1)
  })

  it('platform win32 → skipped-platform, before the global gate is even consulted', () => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec() })
    const isGlobal = vi.fn(() => {
      return true
    })

    expect(ensurePortlessNode(deps(nodeFs, { platform: 'win32', isGlobal }))).toEqual(result('skipped-platform', null))
    expect(isGlobal).not.toHaveBeenCalled()
    expect(nodeFs.calls).toEqual([])
  })

  it('platform linux is in scope', () => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec() })

    expect(ensurePortlessNode(deps(nodeFs, { platform: 'linux' })).outcome).toBe('created')
  })
})

describe('stableNodeCandidate', () => {
  it('is the node path on an inode+dev match', () => {
    const source = exec()
    const nodeFs = fakeNodeFs({ [EXEC]: source, [NODE]: source })

    expect(stableNodeCandidate({ home: HOME, execPath: EXEC, fs: nodeFs })).toBe(NODE)
  })

  it.each<[string, Record<string, NodeEntry>]>([
    ['absent', {}],
    ['a symlink', { [NODE]: { kind: 'symlink' } }],
    ['a directory', { [NODE]: { kind: 'dir' } }],
    ['a different inode', { [NODE]: fileEntry({ ino: 99, dev: 3, size: EXEC_SIZE }) }],
    ['the same inode on another device', { [NODE]: fileEntry({ ino: 7, dev: 4, size: EXEC_SIZE }) }],
  ])('is null when the file is %s', (_, entries) => {
    const nodeFs = fakeNodeFs({ [EXEC]: exec(), ...entries })

    expect(stableNodeCandidate({ home: HOME, execPath: EXEC, fs: nodeFs })).toBeNull()
  })

  it('is null for a copy-path file even with a perfect sidecar — and never reads the sidecar', () => {
    const copy = fileEntry({ ino: 42, dev: 3, size: EXEC_SIZE })
    const readFileSync = vi.fn(() => {
      return sidecarJson({ method: 'copy', sourceSize: EXEC_SIZE })
    })
    const nodeFs = fakeNodeFs(
      { [EXEC]: exec(), [NODE]: copy, [SIDECAR]: sidecarEntry({ method: 'copy', sourceSize: EXEC_SIZE }) },
      { readFileSync },
    )

    expect(stableNodeCandidate({ home: HOME, execPath: EXEC, fs: nodeFs })).toBeNull()
    expect(readFileSync).not.toHaveBeenCalled()
    expect(mutatingCalls(nodeFs.calls)).toEqual([])
  })

  it('never throws: a throwing stat is null', () => {
    const nodeFs = fakeNodeFs(
      {},
      {
        lstatSync: () => {
          throw new Error('EIO')
        },
      },
    )

    expect(stableNodeCandidate({ home: HOME, execPath: EXEC, fs: nodeFs })).toBeNull()
  })
})

describe('readPortlessNodeSidecar', () => {
  it('parses a well-formed sidecar and rejects a malformed one', () => {
    const good = fakeNodeFs({ [SIDECAR]: sidecarEntry({ method: 'copy', sourceSize: 5 }) })
    const bad = fakeNodeFs({ [SIDECAR]: fileEntry({ content: JSON.stringify({ method: 'zip', version: 'v1' }) }) })

    expect(readPortlessNodeSidecar(HOME, good)).toMatchObject({
      method: 'copy',
      sourceSize: 5,
      versionChangedAt: EARLIER,
    })
    expect(readPortlessNodeSidecar(HOME, bad)).toBeNull()
    expect(readPortlessNodeSidecar(HOME, fakeNodeFs())).toBeNull()
  })
})
