/**
 * @fileoverview
 *
 * `~/.infra-kit/node` — a stable, regular-file name for the Node binary the global infra-kit runs, kept
 * current by every process boot beside `~/.infra-kit/portless` (see that module's header for the link).
 *
 * Why a HARDLINK: `portless service install` bakes `process.execPath` into the root plist, and Node
 * realpaths `execPath` (measured: a hardlink of node prints its own path from `-p process.execPath`;
 * a symlink prints the target), so no symlink in front of the binary survives into the plist. Under
 * pnpm 12 the binary lives in `global/v11/{pid}-{ts}/…/node@runtime/…`, a directory every `pnpm add -g`
 * re-mints — with no Node bump. A hardlink is a regular file, costs 0.3 ms and 0 bytes, and its inode
 * outlives the manager's directory, so the name cannot dangle across a re-mint + reboot the way a
 * symlink would. `copyFile(COPYFILE_FICLONE)` is a full 134 MB copy on APFS here, so it is the FALLBACK
 * only: root-owned `/usr/bin/node` under `protected_hardlinks`, a cross-volume home (macOS answers
 * `EPERM`, not `EXDEV`), exFAT/SMB/NFS (`ENOTSUP`), dataless iCloud (`EDEADLK`) — the failure set of
 * `link(2)` is not enumerable, so ANY throw takes the copy. The daemon never consults `execPath` again
 * after boot (`proxy start --foreground` spawns nothing), so that one plist word is the whole contract.
 *
 * T-1 — the hardlink SHARES an inode with the package manager's node, and macOS enforces no `ETXTBSY`:
 * a write through this name lands in the developer's real node and, on Apple Silicon, kills every
 * process mapping it by signature invalidation. Rename-only discipline is the ONLY guard: every byte
 * goes to a `node.tmp-<pid>` sibling and is published by `rename(2)`; the node path is never opened
 * for writing, never chmod'ed (that too mutates the shared inode) and never unlinked. `chmod` runs on
 * the copy branch's tmp alone — the source is executable already, this process executed it.
 *
 * Staleness is one inode compare against `process.execPath`, never a version or byte compare: after a
 * re-mint the source is a new inode with identical bytes and relinking is free. The sidecar keeps two
 * clocks — `refreshedAt` (the file) and `versionChangedAt` (the Node behind it, carried over on a
 * same-version relink) — because doctor's "daemon predates Node …" advisory must not nag after every
 * global install. Neither is an fs timestamp: a hardlink's mtime is the source's install time.
 *
 * Same gate and contract as the link: `isGlobalInstall` is the only thing between a checkout and the
 * root daemon; nothing here spawns, writes stdout, or throws.
 */
import fs from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

import { USER_CONFIG_DIR_NAME } from 'src/lib/constants'

/** `<home>/.infra-kit/node` — the file the plist's first argv word names. */
export const portlessNodePath = (home: string): string => {
  return join(home, USER_CONFIG_DIR_NAME, 'node')
}

/** `<node>.source.json` — what the file is (method, Node triple, source) and the two clocks. */
export const portlessNodeSidecar = (home: string): string => {
  return `${portlessNodePath(home)}.source.json`
}

// Hand-checked, not zod: this module is reached from the `ik-mcp` bundle, which must stay free of every
// node_modules input (`dist-shebang.test.ts`). A sidecar is eight scalars — a validator is cheaper than
// the dependency.
export interface PortlessNodeSidecar {
  method: 'hardlink' | 'copy'
  version: string
  arch: string
  platform: string
  source: string
  sourceSize?: number
  refreshedAt: string
  versionChangedAt: string
}

const isSidecar = (value: unknown): value is PortlessNodeSidecar => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const strings = ['version', 'arch', 'platform', 'source', 'refreshedAt', 'versionChangedAt']

  return (
    (record.method === 'hardlink' || record.method === 'copy') &&
    strings.every((key) => {
      return typeof record[key] === 'string'
    }) &&
    (record.sourceSize === undefined || typeof record.sourceSize === 'number')
  )
}

/** The subset of `fs.Stats` the inode compare and the copy-path size witness need. */
export interface PortlessNodeStat {
  ino: number
  dev: number
  size: number
  isFile: () => boolean
}

/**
 * Every fs call the file needs, as an OBJECT seam: `vi.spyOn` cannot intercept named `node:fs` imports,
 * so tests hand in an in-memory fake and the call log — not the final state — carries the rename-only
 * contract (T-1). `copyFileSync` takes the mode so the FICLONE flag is visible in that log.
 */
export interface PortlessNodeFs {
  mkdirSync: (dir: string, options: { recursive: true }) => unknown
  lstatSync: (target: string, options: { throwIfNoEntry: false }) => PortlessNodeStat | undefined
  statSync: (target: string, options: { throwIfNoEntry: false }) => PortlessNodeStat | undefined
  readFileSync: (target: string, encoding: 'utf8') => string
  writeFileSync: (target: string, data: string) => void
  readdirSync: (dir: string) => string[]
  linkSync: (existing: string, newPath: string) => void
  copyFileSync: (src: string, dest: string, mode: number) => void
  chmodSync: (target: string, mode: number) => void
  renameSync: (from: string, to: string) => void
  unlinkSync: (target: string) => void
}

export type PortlessNodeOutcome =
  'created' | 'refreshed' | 'unchanged' | 'skipped-local' | 'skipped-platform' | 'failed'

export interface PortlessNodeResult {
  kind: 'node'
  outcome: PortlessNodeOutcome
  node: string
  /** The `execPath` the file was (or would have been) made from. */
  source: string
  version: string
  /** How the file relates to `source`; `null` when nothing was published and nothing converged was found. */
  method: 'hardlink' | 'copy' | null
}

export interface EnsurePortlessNodeDeps {
  /** The SAME memoised closure the link uses — the ONLY gate between a checkout and the root daemon. */
  isGlobal: () => boolean
  home: string
  execPath: string
  version: string
  arch: string
  platform: NodeJS.Platform
  fs?: PortlessNodeFs
  now?: () => Date
}

// EXCL is load-bearing, not hygiene: a stale `node.tmp-<pid>` from a boot that died before its `rename`
// can be a HARDLINK of the live node, and a reused pid would hand the copy branch that name — an
// `O_TRUNC` open of it is the T-1 write-through. With EXCL the copy refuses (`EEXIST` → `'failed'`) and
// the next boot's sweep clears the name.
const COPY_FLAGS = fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL
const COPY_MODE = 0o755

/** `null` when the sidecar is absent, unreadable or does not parse — every one of those forces a refresh. */
export const readPortlessNodeSidecar = (home: string, nodeFs: PortlessNodeFs = fs): PortlessNodeSidecar | null => {
  try {
    const parsed: unknown = JSON.parse(nodeFs.readFileSync(portlessNodeSidecar(home), 'utf8'))

    return isSidecar(parsed) ? parsed : null
  } catch {
    return null
  }
}

const sameInode = (a: PortlessNodeStat, b: PortlessNodeStat): boolean => {
  return a.ino === b.ino && a.dev === b.dev
}

/**
 * `<home>/.infra-kit/node` when it is a regular file on the SAME inode as `execPath`, else `null`.
 * Inode equality is proof of runnability — the asking process IS that inode — so this needs no sidecar
 * and no spawn, which is what lets `dev` render the short `service install` line on its hot path. A
 * copy-path file is never a candidate: nothing short of running it proves it runs (doctor's job).
 */
export const stableNodeCandidate = (input: { home: string; execPath: string; fs?: PortlessNodeFs }): string | null => {
  const { home, execPath, fs: nodeFs = fs } = input
  const node = portlessNodePath(home)

  try {
    const current = nodeFs.lstatSync(node, { throwIfNoEntry: false })
    const exec = nodeFs.statSync(execPath, { throwIfNoEntry: false })

    if (current === undefined || exec === undefined || !current.isFile()) return null

    return sameInode(current, exec) ? node : null
  } catch {
    return null
  }
}

type NodeTriple = Pick<EnsurePortlessNodeDeps, 'version' | 'arch' | 'platform'>

const describesProcess = (sidecar: PortlessNodeSidecar, deps: NodeTriple): boolean => {
  return sidecar.version === deps.version && sidecar.arch === deps.arch && sidecar.platform === deps.platform
}

/**
 * The fast path. Inode equality is the strongest signal for the FILE; the version clause is for the
 * SIDECAR: a crash between the two renames after a Node bump leaves the new inode described as the old
 * version with a pre-bump `versionChangedAt`, and without this clause that would be `'unchanged'` forever
 * (doctor printing the wrong version, the restart advisory keyed on a clock that is too old). On the copy
 * path the inode can never match, so the size is the second witness beside the version triple.
 */
const isConverged = (
  current: PortlessNodeStat,
  exec: PortlessNodeStat,
  sidecar: PortlessNodeSidecar,
  deps: NodeTriple,
): boolean => {
  if (!describesProcess(sidecar, deps)) return false
  if (sameInode(current, exec)) return true

  return sidecar.method === 'copy' && sidecar.sourceSize === exec.size
}

const discard = (tmp: string, nodeFs: PortlessNodeFs): void => {
  try {
    nodeFs.unlinkSync(tmp)
  } catch {
    // Best effort: the failure that got us here is the one worth surfacing, not a leftover sibling.
  }
}

/**
 * A SIGKILL mid-copy leaves a 134 MB `node.tmp-<pid>` under a pid that may never recur; the sidecar
 * orphan is ~250 B, but one pass covers both. Only these two prefixes are ours to remove. A concurrent
 * boot's live tmp may go too — its `rename` then fails into `'failed'` and the next boot converges;
 * the published name always holds a complete file.
 */
const sweepOrphans = (dir: string, prefixes: string[], nodeFs: PortlessNodeFs): void => {
  let names: string[]

  try {
    names = nodeFs.readdirSync(dir)
  } catch {
    return
  }

  for (const name of names) {
    const orphan = prefixes.some((prefix) => {
      return name.startsWith(prefix)
    })

    if (orphan) discard(join(dir, name), nodeFs)
  }
}

/** Hardlink first; on ANY throw, the copy (see the header for why the error set is not filtered). */
const stageNode = (execPath: string, tmp: string, nodeFs: PortlessNodeFs): 'hardlink' | 'copy' => {
  try {
    nodeFs.linkSync(execPath, tmp)

    return 'hardlink'
  } catch {
    nodeFs.copyFileSync(execPath, tmp, COPY_FLAGS)
    // The copy branch ONLY: on a hardlink this would chmod the manager's inode. 0755 is what the source
    // carries and what root needs to exec a file under a 0700 home — no secret lives in a node binary.
    // eslint-disable-next-line sonarjs/file-permissions -- an executable's mode, not a data file's
    nodeFs.chmodSync(tmp, COPY_MODE)

    return 'copy'
  }
}

/**
 * Stage under the pid-suffixed sibling, publish by ONE `rename` (T-1). The old inode stays mapped by a
 * running daemon; `rename` touches no byte of it. On any throw the sibling is removed and the old file
 * is exactly as it was.
 */
const publishNode = (execPath: string, node: string, nodeFs: PortlessNodeFs): 'hardlink' | 'copy' => {
  const tmp = `${node}.tmp-${process.pid}`

  try {
    const method = stageNode(execPath, tmp, nodeFs)

    nodeFs.renameSync(tmp, node)

    return method
  } catch (error) {
    discard(tmp, nodeFs)
    throw error
  }
}

const publishSidecar = (sidecarPath: string, sidecar: PortlessNodeSidecar, nodeFs: PortlessNodeFs): void => {
  const tmp = `${sidecarPath}.tmp-${process.pid}`

  try {
    nodeFs.writeFileSync(tmp, `${JSON.stringify(sidecar, null, 2)}\n`)
    nodeFs.renameSync(tmp, sidecarPath)
  } catch (error) {
    discard(tmp, nodeFs)
    throw error
  }
}

/**
 * `versionChangedAt` is carried over only when the Node behind the file is the same one the previous
 * sidecar described: the triple, plus the size whenever the previous sidecar recorded one (a copy of a
 * same-version different build IS a different Node). A same-version relink after a re-mint must not
 * look like a Node bump to doctor's restart advisory. No parsable previous sidecar → `now`, which errs
 * towards one advisory too many, never too few.
 */
const nextSidecar = (
  previous: PortlessNodeSidecar | null,
  method: 'hardlink' | 'copy',
  exec: PortlessNodeStat,
  deps: EnsurePortlessNodeDeps,
  now: string,
): PortlessNodeSidecar => {
  const sameNode =
    previous !== null &&
    describesProcess(previous, deps) &&
    (previous.sourceSize === undefined || previous.sourceSize === exec.size)

  return {
    method,
    version: deps.version,
    arch: deps.arch,
    platform: deps.platform,
    source: deps.execPath,
    ...(method === 'copy' ? { sourceSize: exec.size } : {}),
    refreshedAt: now,
    versionChangedAt: sameNode ? previous.versionChangedAt : now,
  }
}

/**
 * Converge `~/.infra-kit/node` on the Node running THIS install. Never throws; every outcome is a value.
 *
 * A symlink or directory at the path is `'failed'` and left exactly as found — this code owns a regular
 * file, and removing whatever someone else put there is the one destructive act a boot hook must never
 * take. A converged machine pays one `lstat`, one `stat` and a ~250-byte read: no write, no subprocess.
 *
 * @example
 * ensurePortlessNode({ isGlobal: () => true, home: '/Users/x', execPath: process.execPath, version: process.version, arch: process.arch, platform: process.platform })
 * // => { kind: 'node', outcome: 'created', node: '/Users/x/.infra-kit/node', source: process.execPath, version: process.version, method: 'hardlink' }
 */
export const ensurePortlessNode = (deps: EnsurePortlessNodeDeps): PortlessNodeResult => {
  const {
    home,
    execPath,
    version,
    fs: nodeFs = fs,
    now = () => {
      return new Date()
    },
  } = deps
  const node = portlessNodePath(home)
  const sidecarPath = portlessNodeSidecar(home)
  const result = (outcome: PortlessNodeOutcome, method: PortlessNodeResult['method']): PortlessNodeResult => {
    return { kind: 'node', outcome, node, source: execPath, version, method }
  }

  if (deps.platform !== 'darwin' && deps.platform !== 'linux') return result('skipped-platform', null)
  if (!deps.isGlobal()) return result('skipped-local', null)

  try {
    nodeFs.mkdirSync(dirname(node), { recursive: true })

    const current = nodeFs.lstatSync(node, { throwIfNoEntry: false })

    if (current !== undefined && !current.isFile()) return result('failed', null)

    const exec = nodeFs.statSync(execPath, { throwIfNoEntry: false })

    if (exec === undefined) return result('failed', null)

    const previous = readPortlessNodeSidecar(home, nodeFs)

    if (current !== undefined && previous !== null && isConverged(current, exec, previous, deps)) {
      return result('unchanged', previous.method)
    }

    sweepOrphans(dirname(node), [`${basename(node)}.tmp-`, `${basename(sidecarPath)}.tmp-`], nodeFs)

    const method = publishNode(execPath, node, nodeFs)

    publishSidecar(sidecarPath, nextSidecar(previous, method, exec, deps, now().toISOString()), nodeFs)

    return result(current === undefined ? 'created' : 'refreshed', method)
  } catch {
    return result('failed', null)
  }
}
