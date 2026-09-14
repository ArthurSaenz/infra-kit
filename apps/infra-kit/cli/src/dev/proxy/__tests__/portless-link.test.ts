import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'

import {
  bootPortlessLink,
  ensurePortlessLink,
  portlessLinkCliPath,
  portlessLinkPath,
} from 'src/dev/proxy/portless-link'
import type { EnsurePortlessLinkDeps, PortlessLinkResult } from 'src/dev/proxy/portless-link'

import { fakeLinkFs, symlinkTo } from './portless-link-fixtures'
import type { FakeLinkFs } from './portless-link-fixtures'

const HOME = '/Users/ada'
const LINK = `${HOME}/.infra-kit/portless`
const STORE = '/Users/ada/Library/pnpm/global/v11/8a83-1/node_modules/.pnpm'
const TARGET = `${STORE}/infra-kit@0.5.6/node_modules/portless`
const BIN = `${TARGET}/dist/cli.js`
const TMP = `${LINK}.tmp-${process.pid}`

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

    expect(ensurePortlessLink(deps(fs))).toEqual<PortlessLinkResult>({ outcome: 'created', target: TARGET, link: LINK })
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
    ).toEqual<PortlessLinkResult>({ outcome: 'skipped-local', target: TARGET, link: LINK })
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
    ).toEqual<PortlessLinkResult>({ outcome: 'skipped-unresolved', target: null, link: LINK })
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

    expect(ensurePortlessLink(deps(fs))).toEqual<PortlessLinkResult>({ outcome: 'failed', target: TARGET, link: LINK })
    expect(fs.tree.get(LINK)).toEqual({ kind: 'dir' })
    expect(
      fs.calls.filter((call) => {
        return !call.startsWith('mkdir')
      }),
    ).toEqual([])
  })
})

describe('bootPortlessLink', () => {
  it('hands the full result (outcome + target + link) to the log seam under one message', () => {
    const log = vi.fn()

    bootPortlessLink(log, deps(fakeLinkFs({ [LINK]: symlinkTo(TARGET) })))

    expect(log).toHaveBeenCalledWith({ outcome: 'unchanged', target: TARGET, link: LINK }, 'portless link')
  })

  it("'failed' emits a log line carrying the target and the link", () => {
    const log = vi.fn()

    bootPortlessLink(log, deps(fakeLinkFs({ [LINK]: { kind: 'dir' } })))

    expect(log).toHaveBeenCalledWith({ outcome: 'failed', target: TARGET, link: LINK }, 'portless link')
  })

  it('never throws: a throwing log seam is swallowed, a throwing resolveBin is swallowed', () => {
    expect(() => {
      bootPortlessLink(() => {
        throw new Error('logger is broken')
      }, deps(fakeLinkFs()))
    }).not.toThrow()
    expect(() => {
      bootPortlessLink(
        vi.fn(),
        deps(fakeLinkFs(), {
          resolveBin: () => {
            throw new Error('walk failed')
          },
        }),
      )
    }).not.toThrow()
  })

  it('with the real seams, from this checkout, reports skipped-local (a `.git` sits above node_modules)', () => {
    // The only real-disk case: `import.meta.url` is a file in this repo, so the `.git` walk refuses it.
    // This is also the guarantee that running the test suite never writes into the developer's
    // ~/.infra-kit — the ONE outcome the unit lane must prove against the real `isGlobalInstall`.
    const log = vi.fn<(result: PortlessLinkResult, message: string) => void>()

    bootPortlessLink(log)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0].outcome).toBe('skipped-local')
  })
})
