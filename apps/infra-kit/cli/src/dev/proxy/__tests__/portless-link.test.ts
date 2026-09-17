import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  bootPortlessLink,
  ensurePortlessLink,
  portlessLinkCliPath,
  portlessLinkPath,
  realPortlessStableDeps,
  serviceInstallCommand,
} from 'src/dev/proxy/portless-link'
import type {
  EnsurePortlessLinkDeps,
  PortlessLinkLog,
  PortlessLinkResult,
  PortlessStableDeps,
} from 'src/dev/proxy/portless-link'
import type { EnsurePortlessNodeDeps } from 'src/dev/proxy/portless-node'

import { fakeLinkFs, fakeNodeFs, fileEntry, symlinkTo } from './portless-link-fixtures'
import type { FakeLinkFs, FakeNodeFs } from './portless-link-fixtures'

const HOME = '/Users/ada'
const LINK = `${HOME}/.infra-kit/portless`
const STORE = '/Users/ada/Library/pnpm/global/v11/8a83-1/node_modules/.pnpm'
const TARGET = `${STORE}/infra-kit@0.5.6/node_modules/portless`
const BIN = `${TARGET}/dist/cli.js`
const TMP = `${LINK}.tmp-${process.pid}`

const EXEC = '/Users/ada/Library/pnpm/global/v11/8a83-1/node_modules/node/bin/node'
const NODE = `${HOME}/.infra-kit/node`

const deps = (fs: FakeLinkFs, overrides: Partial<EnsurePortlessLinkDeps> = {}): EnsurePortlessLinkDeps => {
  return {
    resolveBin: () => {
      return BIN
    },
    isGlobal: () => {
      return true
    },
    home: HOME,
    fs,
    ...overrides,
  }
}

const nodeDeps = (fs: FakeNodeFs, overrides: Partial<EnsurePortlessNodeDeps> = {}): EnsurePortlessNodeDeps => {
  return {
    isGlobal: () => {
      return true
    },
    home: HOME,
    execPath: EXEC,
    version: 'v24.21.0',
    arch: 'arm64',
    platform: 'darwin',
    fs,
    ...overrides,
  }
}

/** A converged pair: link in place, node hardlinked (same inode as `EXEC`) with a sidecar that matches. */
const convergedStable = (): PortlessStableDeps => {
  const exec = fileEntry({ ino: 7, dev: 3, size: 100 })
  const sidecar = JSON.stringify({
    method: 'hardlink',
    version: 'v24.21.0',
    arch: 'arm64',
    platform: 'darwin',
    source: EXEC,
    refreshedAt: '2026-09-17T09:24:11.000Z',
    versionChangedAt: '2026-09-13T18:02:40.000Z',
  })

  return {
    link: deps(fakeLinkFs({ [LINK]: symlinkTo(TARGET) })),
    node: nodeDeps(
      fakeNodeFs({ [EXEC]: exec, [NODE]: exec, [`${NODE}.source.json`]: fileEntry({ content: sidecar }) }),
    ),
  }
}

describe('portlessLinkPath / portlessLinkCliPath', () => {
  it('names the link under the shared user config dir', () => {
    expect(portlessLinkPath(HOME)).toBe(LINK)
  })

  it('returns <link>/dist/cli.js only when that file exists through the link', () => {
    const cli = `${LINK}/dist/cli.js`

    expect(
      portlessLinkCliPath(HOME, (target) => {
        return target === cli
      }),
    ).toBe(cli)
    expect(
      portlessLinkCliPath(HOME, () => {
        return false
      }),
    ).toBeNull()
  })
})

describe('ensurePortlessLink', () => {
  it('no link → created, pointing at the portless PACKAGE dir (two levels above the bin)', () => {
    const fs = fakeLinkFs()

    expect(ensurePortlessLink(deps(fs))).toEqual<PortlessLinkResult>({
      kind: 'link',
      outcome: 'created',
      target: TARGET,
      link: LINK,
    })
    expect(fs.tree.get(LINK)).toEqual(symlinkTo(TARGET))
    expect(fs.calls).toEqual([
      `mkdir ${HOME}/.infra-kit`,
      `unlink ${TMP}`,
      `symlink ${TMP} -> ${TARGET}`,
      `rename ${TMP} -> ${LINK}`,
    ])
  })

  it('creates ~/.infra-kit when it is missing (recursive mkdir, before any link write)', () => {
    const fs = fakeLinkFs()

    ensurePortlessLink(deps(fs))

    expect(fs.calls[0]).toBe(`mkdir ${HOME}/.infra-kit`)
    expect(fs.tree.get(`${HOME}/.infra-kit`)).toEqual({ kind: 'dir' })
  })

  it('link already correct → unchanged, with ZERO symlink/rename/unlink calls', () => {
    const fs = fakeLinkFs({ [LINK]: symlinkTo(TARGET) })

    expect(ensurePortlessLink(deps(fs)).outcome).toBe('unchanged')
    expect(
      fs.calls.filter((call) => {
        return !call.startsWith('mkdir')
      }),
    ).toEqual([])
  })

  it('dangling link → repointed via tmp + rename, and the old link is never unlinked first', () => {
    // Dangling = the entry exists as a symlink but its target does not; lstat/readlink still answer.
    const fs = fakeLinkFs({ [LINK]: symlinkTo(`${STORE}/infra-kit@0.5.2/node_modules/portless`) })

    expect(ensurePortlessLink(deps(fs)).outcome).toBe('repointed')
    expect(fs.tree.get(LINK)).toEqual(symlinkTo(TARGET))
    // The only unlink names the tmp sibling (clearing a possible leftover) — never the link itself.
    expect(
      fs.calls.filter((call) => {
        return call.startsWith('unlink')
      }),
    ).toEqual([`unlink ${TMP}`])
    expect(fs.calls.slice(-2)).toEqual([`symlink ${TMP} -> ${TARGET}`, `rename ${TMP} -> ${LINK}`])
  })

  it('link points at a different, existing portless → repointed', () => {
    const other = '/opt/homebrew/lib/node_modules/portless'
    const fs = fakeLinkFs({ [LINK]: symlinkTo(other), [other]: { kind: 'dir' } })

    expect(ensurePortlessLink(deps(fs))).toMatchObject({ outcome: 'repointed', target: TARGET })
    expect(fs.tree.get(LINK)).toEqual(symlinkTo(TARGET))
  })

  it('project-local install → skipped-local, no writes at all', () => {
    const fs = fakeLinkFs()

    expect(
      ensurePortlessLink(
        deps(fs, {
          isGlobal: () => {
            return false
          },
        }),
      ),
    ).toEqual<PortlessLinkResult>({ kind: 'link', outcome: 'skipped-local', target: TARGET, link: LINK })
    expect(fs.calls).toEqual([])
    expect(fs.tree.size).toBe(0)
  })

  it('portless not resolvable → skipped-unresolved, before the global gate is even consulted', () => {
    const fs = fakeLinkFs()
    const isGlobal = vi.fn(() => {
      return true
    })

    expect(
      ensurePortlessLink(
        deps(fs, {
          resolveBin: () => {
            return null
          },
          isGlobal,
        }),
      ),
    ).toEqual<PortlessLinkResult>({ kind: 'link', outcome: 'skipped-unresolved', target: null, link: LINK })
    expect(isGlobal).not.toHaveBeenCalled()
    expect(fs.calls).toEqual([])
  })

  it('rename throws → failed, nothing escapes, and the tmp sibling is cleaned up', () => {
    const fs = fakeLinkFs(
      {},
      {
        renameSync: () => {
          throw new Error('EXDEV: cross-device rename')
        },
      },
    )

    expect(() => {
      return ensurePortlessLink(deps(fs))
    }).not.toThrow()
    expect(ensurePortlessLink(deps(fs)).outcome).toBe('failed')
    // Every unlink ever issued names the tmp sibling — never the link itself: one clearing pass before
    // each symlink, one cleanup after each failed rename.
    expect(
      fs.calls.filter((call) => {
        return call.startsWith('unlink')
      }),
    ).toEqual([`unlink ${TMP}`, `unlink ${TMP}`, `unlink ${TMP}`, `unlink ${TMP}`])
    expect(fs.tree.has(LINK)).toBe(false)
    expect(fs.tree.has(TMP)).toBe(false)
  })

  it('a stale tmp sibling from a crashed run (same pid reused) is cleared, and the link is still created', () => {
    const fs = fakeLinkFs({ [TMP]: symlinkTo('/stale') })

    expect(ensurePortlessLink(deps(fs)).outcome).toBe('created')
    expect(fs.tree.get(LINK)).toEqual(symlinkTo(TARGET))
    expect(fs.tree.has(TMP)).toBe(false)
    expect(fs.calls.slice(-3)).toEqual([`unlink ${TMP}`, `symlink ${TMP} -> ${TARGET}`, `rename ${TMP} -> ${LINK}`])
  })

  it('a stale tmp sibling beside an outdated link → repointed, and the link itself is never unlinked', () => {
    const fs = fakeLinkFs({
      [TMP]: symlinkTo('/stale'),
      [LINK]: symlinkTo(`${STORE}/infra-kit@0.5.2/node_modules/portless`),
    })

    expect(ensurePortlessLink(deps(fs)).outcome).toBe('repointed')
    expect(fs.tree.get(LINK)).toEqual(symlinkTo(TARGET))
    expect(
      fs.calls.filter((call) => {
        return call.startsWith('unlink')
      }),
    ).toEqual([`unlink ${TMP}`])
  })

  it('symlink throws for any other reason → failed, no throw', () => {
    const fs = fakeLinkFs(
      {},
      {
        symlinkSync: () => {
          throw new Error('EACCES')
        },
      },
    )

    expect(ensurePortlessLink(deps(fs)).outcome).toBe('failed')
    expect(fs.tree.has(LINK)).toBe(false)
  })

  it('mkdir throws → failed, no throw', () => {
    const fs = fakeLinkFs(
      {},
      {
        mkdirSync: () => {
          throw new Error('EACCES')
        },
      },
    )

    expect(ensurePortlessLink(deps(fs)).outcome).toBe('failed')
  })

  it('a regular DIRECTORY at the link path → failed, and it is never removed or renamed over', () => {
    const fs = fakeLinkFs({ [LINK]: { kind: 'dir' } })

    expect(ensurePortlessLink(deps(fs))).toEqual<PortlessLinkResult>({
      kind: 'link',
      outcome: 'failed',
      target: TARGET,
      link: LINK,
    })
    expect(fs.tree.get(LINK)).toEqual({ kind: 'dir' })
    expect(
      fs.calls.filter((call) => {
        return !call.startsWith('mkdir')
      }),
    ).toEqual([])
  })
})

describe('bootPortlessLink', () => {
  it('logs the link result, then the node result, each under its own message and discriminated by `kind`', () => {
    const log = vi.fn()

    bootPortlessLink(log, convergedStable())

    expect(log).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenNthCalledWith(
      1,
      { kind: 'link', outcome: 'unchanged', target: TARGET, link: LINK },
      'portless link',
    )
    expect(log).toHaveBeenNthCalledWith(
      2,
      { kind: 'node', outcome: 'unchanged', node: NODE, source: EXEC, version: 'v24.21.0', method: 'hardlink' },
      'portless node',
    )
  })

  it("'failed' emits a log line carrying the target and the link", () => {
    const log = vi.fn()
    const stable = convergedStable()

    bootPortlessLink(log, { ...stable, link: deps(fakeLinkFs({ [LINK]: { kind: 'dir' } })) })

    expect(log).toHaveBeenCalledWith({ kind: 'link', outcome: 'failed', target: TARGET, link: LINK }, 'portless link')
  })

  it("the node 'failed' line carries the node path and its source, so the ik-mcp stderr line can name both", () => {
    const log = vi.fn()
    const stable = convergedStable()

    bootPortlessLink(log, {
      ...stable,
      node: nodeDeps(fakeNodeFs({ [EXEC]: fileEntry(), [NODE]: { kind: 'symlink' } })),
    })

    expect(log).toHaveBeenLastCalledWith(
      { kind: 'node', outcome: 'failed', node: NODE, source: EXEC, version: 'v24.21.0', method: null },
      'portless node',
    )
  })

  it("the node step runs even when the link is 'skipped-unresolved' — the two are independent state", () => {
    const log = vi.fn<PortlessLinkLog>()
    const stable = convergedStable()

    bootPortlessLink(log, {
      ...stable,
      link: deps(fakeLinkFs(), {
        resolveBin: () => {
          return null
        },
      }),
    })

    expect(
      log.mock.calls.map(([result]) => {
        return result.outcome
      }),
    ).toEqual(['skipped-unresolved', 'unchanged'])
  })

  it('never throws: a throwing log seam, a throwing resolveBin and a throwing node dep are all swallowed', () => {
    expect(() => {
      bootPortlessLink(() => {
        throw new Error('logger is broken')
      }, convergedStable())
    }).not.toThrow()
    expect(() => {
      bootPortlessLink(vi.fn(), {
        ...convergedStable(),
        link: deps(fakeLinkFs(), {
          resolveBin: () => {
            throw new Error('walk failed')
          },
        }),
      })
    }).not.toThrow()

    const log = vi.fn<PortlessLinkLog>()

    expect(() => {
      bootPortlessLink(log, {
        ...convergedStable(),
        node: nodeDeps(fakeNodeFs(), {
          isGlobal: () => {
            throw new Error('gate exploded')
          },
        }),
      })
    }).not.toThrow()
    // The link step still logged; the node step's throw was contained.
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('a throwing log on the link step does not stop the node step', () => {
    const log = vi.fn<PortlessLinkLog>((result) => {
      if (result.kind === 'link') throw new Error('logger is broken for links')
    })

    bootPortlessLink(log, convergedStable())

    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[1]?.[0].kind).toBe('node')
  })

  it('with the real seams, from this checkout, both steps report skipped-local (a `.git` sits above node_modules)', () => {
    // The only real-disk case: `import.meta.url` is a file in this repo, so the `.git` walk refuses it.
    // This is also the guarantee that running the test suite never writes into the developer's
    // ~/.infra-kit — the ONE outcome the unit lane must prove against the real `isGlobalInstall`.
    const log = vi.fn<PortlessLinkLog>()

    bootPortlessLink(log)

    expect(log).toHaveBeenCalledTimes(2)
    expect(
      log.mock.calls.map(([result]) => {
        return [result.kind, result.outcome]
      }),
    ).toEqual([
      ['link', 'skipped-local'],
      ['node', 'skipped-local'],
    ])
  })
})

describe('realPortlessStableDeps', () => {
  it('shares ONE memoised isGlobal between the link and the node: two steps, one realpath + .git walk', () => {
    const stable = realPortlessStableDeps()

    expect(stable.node.isGlobal).toBe(stable.link.isGlobal)

    // The real gate is not injectable here, so the memo is proven by identity above and by cost below:
    // `realpathSync` is what the closure pays, and after the first answer it is never asked again.
    const realpath = vi.spyOn(fs, 'realpathSync')

    stable.link.isGlobal()
    stable.node.isGlobal()
    stable.link.isGlobal()

    expect(realpath).toHaveBeenCalledTimes(1)
    realpath.mockRestore()
  })

  it('the node deps describe THIS process', () => {
    const { node } = realPortlessStableDeps()

    expect(node).toMatchObject({
      home: os.homedir(),
      execPath: process.execPath,
      version: process.version,
      arch: process.arch,
      platform: process.platform,
    })
  })
})

describe('serviceInstallCommand', () => {
  const FALLBACK_BIN = '/deep/node_modules/portless/dist/cli.js'
  const LINK_CLI = `${LINK}/dist/cli.js`
  const linkResolves = (target: string): boolean => {
    return target === LINK_CLI
  }

  // A real temp home is the only honest way to make the inode-only candidate true: a hardlink of the
  // running node. Creating a hardlink adds a NAME to the inode; removing the temp dir removes that
  // name — neither writes through to the binary (T-1). No `copyFileSync` onto anything here.
  let tempHome: string | null = null

  afterEach(() => {
    if (tempHome !== null) fs.rmSync(tempHome, { recursive: true, force: true })
    tempHome = null
  })

  const homeWithCandidate = (): string => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-stable-node-'))
    fs.mkdirSync(path.join(tempHome, '.infra-kit'))
    fs.linkSync(process.execPath, path.join(tempHome, '.infra-kit', 'node'))

    return tempHome
  }

  it('no link, nothing resolved → the fallback bin under the current execPath', () => {
    expect(
      serviceInstallCommand(FALLBACK_BIN, {
        home: HOME,
        exists: () => {
          return false
        },
        execPath: '/opt/node/bin/node',
      }),
    ).toBe(`sudo /opt/node/bin/node ${FALLBACK_BIN} service install`)
  })

  it('link only (no stable node at that home) → through the link, under execPath', () => {
    expect(
      serviceInstallCommand(FALLBACK_BIN, { home: HOME, exists: linkResolves, execPath: '/opt/node/bin/node' }),
    ).toBe(`sudo /opt/node/bin/node ${LINK_CLI} service install`)
  })

  it('link + a healthy stableNode verdict → the short line, both words under ~/.infra-kit', () => {
    expect(
      serviceInstallCommand(FALLBACK_BIN, {
        home: HOME,
        exists: linkResolves,
        execPath: '/opt/node/bin/node',
        stableNode: NODE,
      }),
    ).toBe(`sudo ${NODE} ${LINK_CLI} service install`)
  })

  it('link + a null verdict → execPath, even when the candidate check would have said yes', () => {
    const home = homeWithCandidate()

    expect(
      serviceInstallCommand(FALLBACK_BIN, {
        home,
        exists: () => {
          return false
        },
        stableNode: null,
      }),
    ).toBe(`sudo ${process.execPath} ${FALLBACK_BIN} service install`)
  })

  it('stableNode undefined + a hardlink of this process at <home>/.infra-kit/node → the candidate is printed', () => {
    const home = homeWithCandidate()

    expect(
      serviceInstallCommand(FALLBACK_BIN, {
        home,
        exists: () => {
          return false
        },
      }),
    ).toBe(`sudo ${path.join(home, '.infra-kit', 'node')} ${FALLBACK_BIN} service install`)
  })

  it('stableNode undefined + no candidate → execPath (the default seam, as `dev` passes it)', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-no-stable-node-'))

    expect(
      serviceInstallCommand(FALLBACK_BIN, {
        home: tempHome,
        exists: () => {
          return false
        },
      }),
    ).toBe(`sudo ${process.execPath} ${FALLBACK_BIN} service install`)
  })
})
