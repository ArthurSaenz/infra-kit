import fs from 'node:fs'
import process from 'node:process'

import type { PortlessLinkFs } from 'src/dev/proxy/portless-link'
import { portlessNodePath, portlessNodeSidecar } from 'src/dev/proxy/portless-node'
import type { PortlessNodeFs, PortlessNodeSidecar, PortlessNodeStat } from 'src/dev/proxy/portless-node'

/**
 * An in-memory `PortlessLinkFs`: a `Map` keyed by path, seeded with whatever is "already on disk", so
 * `ensurePortlessLink` runs for real against it without ever touching `~/.infra-kit`. Every mutating
 * call is recorded by name, so the "zero writes" and "never unlink first" contracts are asserted on the
 * CALL LOG, not inferred from the final state — a final state of "link points at target" is reachable
 * by unlink+symlink too, which is the sequence the module exists to avoid.
 */
export type LinkEntry = { kind: 'symlink'; target: string } | { kind: 'dir' }

export interface FakeLinkFs extends PortlessLinkFs {
  tree: Map<string, LinkEntry>
  calls: string[]
}

export const fakeLinkFs = (
  entries: Record<string, LinkEntry> = {},
  overrides: Partial<Pick<PortlessLinkFs, 'renameSync' | 'symlinkSync' | 'mkdirSync'>> = {},
): FakeLinkFs => {
  const tree = new Map(Object.entries(entries))
  const calls: string[] = []

  return {
    tree,
    calls,
    mkdirSync: (dir) => {
      calls.push(`mkdir ${dir}`)
      tree.set(dir, { kind: 'dir' })
    },
    lstatSync: (target) => {
      const entry = tree.get(target)

      return entry === undefined
        ? undefined
        : {
            isSymbolicLink: () => {
              return entry.kind === 'symlink'
            },
          }
    },
    readlinkSync: (target) => {
      const entry = tree.get(target)

      if (entry?.kind !== 'symlink') throw new Error(`EINVAL: not a symlink: ${target}`)

      return entry.target
    },
    symlinkSync: (target, linkPath) => {
      calls.push(`symlink ${linkPath} -> ${target}`)
      if (tree.has(linkPath)) throw new Error(`EEXIST: ${linkPath}`)
      tree.set(linkPath, { kind: 'symlink', target })
    },
    renameSync: (from, to) => {
      calls.push(`rename ${from} -> ${to}`)

      const entry = tree.get(from)

      if (entry === undefined) throw new Error(`ENOENT: ${from}`)
      tree.delete(from)
      tree.set(to, entry)
    },
    unlinkSync: (target) => {
      calls.push(`unlink ${target}`)
      if (!tree.has(target)) throw new Error(`ENOENT: ${target}`)
      tree.delete(target)
    },
    ...overrides,
  }
}

export const symlinkTo = (target: string): LinkEntry => {
  return { kind: 'symlink', target }
}

/**
 * An in-memory `PortlessNodeFs` for `ensurePortlessNode`. Files carry an inode so the fast path's
 * `ino/dev` compare runs for real; `linkSync` aliases the SAME entry (one inode, two names) and
 * `copyFileSync` mints a fresh one, so "hardlink or copy" is observable in the tree as well as the log.
 * Reads (`lstat`/`stat`/`readFile`) are not logged: the contracts under test are about writes.
 */
export type NodeEntry =
  { kind: 'file'; ino: number; dev: number; size: number; content?: string } | { kind: 'symlink' } | { kind: 'dir' }

export interface FakeNodeFs extends PortlessNodeFs {
  tree: Map<string, NodeEntry>
  calls: string[]
}

let nextIno = 1000

export const fileEntry = (input: { ino?: number; dev?: number; size?: number; content?: string } = {}): NodeEntry => {
  nextIno += 1

  return { kind: 'file', ino: input.ino ?? nextIno, dev: input.dev ?? 1, size: input.size ?? 0, content: input.content }
}

const statOf = (entry: NodeEntry): PortlessNodeStat => {
  return {
    ino: entry.kind === 'file' ? entry.ino : 0,
    dev: entry.kind === 'file' ? entry.dev : 0,
    size: entry.kind === 'file' ? entry.size : 0,
    isFile: () => {
      return entry.kind === 'file'
    },
  }
}

export const fakeNodeFs = (
  entries: Record<string, NodeEntry> = {},
  overrides: Partial<PortlessNodeFs> = {},
): FakeNodeFs => {
  const tree = new Map(Object.entries(entries))
  const calls: string[] = []

  const mustGet = (target: string): NodeEntry => {
    const entry = tree.get(target)

    if (entry === undefined) throw new Error(`ENOENT: ${target}`)

    return entry
  }

  return {
    tree,
    calls,
    mkdirSync: (dir) => {
      calls.push(`mkdir ${dir}`)
      tree.set(dir, { kind: 'dir' })
    },
    lstatSync: (target) => {
      const entry = tree.get(target)

      return entry === undefined ? undefined : statOf(entry)
    },
    statSync: (target) => {
      const entry = tree.get(target)

      // A symlink entry has no target in this fake, so following it is "dangling".
      return entry === undefined || entry.kind === 'symlink' ? undefined : statOf(entry)
    },
    readFileSync: (target) => {
      const entry = mustGet(target)

      if (entry.kind !== 'file' || entry.content === undefined) throw new Error(`EISDIR: ${target}`)

      return entry.content
    },
    writeFileSync: (target, data) => {
      calls.push(`writeFile ${target}`)
      tree.set(target, fileEntry({ size: data.length, content: data }))
    },
    readdirSync: (dir) => {
      calls.push(`readdir ${dir}`)

      return [...tree.keys()]
        .filter((key) => {
          return key !== dir && key.startsWith(`${dir}/`) && !key.slice(dir.length + 1).includes('/')
        })
        .map((key) => {
          return key.slice(dir.length + 1)
        })
    },
    linkSync: (existing, newPath) => {
      calls.push(`link ${existing} -> ${newPath}`)

      const entry = mustGet(existing)

      if (tree.has(newPath)) throw new Error(`EEXIST: ${newPath}`)
      tree.set(newPath, entry)
    },
    copyFileSync: (src, dest, mode) => {
      calls.push(`copyFile ${src} -> ${dest} ${mode}`)

      const entry = mustGet(src)

      if (entry.kind !== 'file') throw new Error(`EISDIR: ${src}`)
      // The real call truncates an existing `dest` unless EXCL is set — the T-1 hazard the fake must keep.
      if ((mode & fs.constants.COPYFILE_EXCL) !== 0 && tree.has(dest)) throw new Error(`EEXIST: ${dest}`)
      tree.set(dest, fileEntry({ size: entry.size, content: entry.content }))
    },
    chmodSync: (target, mode) => {
      calls.push(`chmod ${target} ${mode.toString(8)}`)
      mustGet(target)
    },
    renameSync: (from, to) => {
      calls.push(`rename ${from} -> ${to}`)

      const entry = mustGet(from)

      tree.delete(from)
      tree.set(to, entry)
    },
    unlinkSync: (target) => {
      calls.push(`unlink ${target}`)
      mustGet(target)
      tree.delete(target)
    },
    ...overrides,
  }
}

/**
 * A `node.source.json` entry naming THIS process — doctor's triple defaults to `process.*`, so a fixture
 * that does not override it agrees with the row under test. `source` has no sensible default: it is the
 * path the rows print.
 */
export const sidecarFor = (source: string, overrides: Partial<PortlessNodeSidecar> = {}): NodeEntry => {
  const content = JSON.stringify({
    method: 'hardlink',
    version: process.version,
    arch: process.arch,
    platform: 'darwin',
    source,
    refreshedAt: '2026-09-10T00:00:00.000Z',
    versionChangedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  })

  return fileEntry({ size: content.length, content })
}

/** `~/.infra-kit/node` as the boot hook leaves it on a healthy machine (N8): one inode under both names, plus the sidecar. */
export const hardlinkNodeFs = (input: {
  home: string
  execPath: string
  size?: number
  sidecar?: Partial<PortlessNodeSidecar>
}): FakeNodeFs => {
  const node = fileEntry({ ino: 7, dev: 1, size: input.size ?? 100 })

  return fakeNodeFs({
    [input.execPath]: node,
    [portlessNodePath(input.home)]: node,
    [portlessNodeSidecar(input.home)]: sidecarFor(input.execPath, input.sidecar),
  })
}

/** Every logged call that changes the tree — `mkdir` and `readdir` are the free lookups the fast path is allowed. */
export const mutatingCalls = (calls: string[]): string[] => {
  return calls.filter((call) => {
    return !call.startsWith('mkdir ') && !call.startsWith('readdir ')
  })
}

/**
 * T-1, asserted on the CALL LOG in every case: the node path and its sidecar are only ever the
 * destination of a `rename`; `writeFile`, `chmod`, `unlink`, `link` and `copyFile` name a `.tmp-`
 * sibling or nothing. A hardlink shares its inode with the developer's real node and macOS has no
 * `ETXTBSY`, so a write through the published name is the one bug this module can never have.
 */
export const expectRenameOnly = (calls: string[], node: string): void => {
  const published = new Set([node, `${node}.source.json`])

  for (const call of calls) {
    const [verb, ...rest] = call.split(' ')
    const target = verb === 'link' || verb === 'copyFile' || verb === 'rename' ? rest[2] : rest[0]

    if (target === undefined || verb === 'mkdir' || verb === 'readdir') continue
    if (published.has(target) && verb !== 'rename') throw new Error(`T-1 violated: ${call}`)
    if (verb !== 'rename' && !target.includes('.tmp-')) throw new Error(`write outside a tmp sibling: ${call}`)
    // A tmp name can itself alias the live inode (a dead boot's hardlink under a reused pid), so every
    // copy must refuse an existing destination.
    if (verb === 'copyFile' && (Number(rest[3]) & fs.constants.COPYFILE_EXCL) === 0) {
      throw new Error(`copy without COPYFILE_EXCL: ${call}`)
    }
  }
}
