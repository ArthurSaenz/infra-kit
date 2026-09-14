import type { PortlessLinkFs } from 'src/dev/proxy/portless-link'

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
