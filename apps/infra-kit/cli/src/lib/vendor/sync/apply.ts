import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { writeManifest } from '../manifest'
import { VENDOR_DIR, isSkippedPath } from '../skip-sets'
import { fingerprintOnDisk } from './fingerprint'
import { runGit, splitNul } from './git'
import { VENDOR_MANIFEST_PATH, VENDOR_README_PATH, toVendorRelative } from './paths'
import { vendorReadme } from './readme'
import { listTrackedVendorPaths } from './tracked-files'
import type { ApplyResult, EntryPlan, SourceIdentity, TargetPlan, WriteOp } from './types'

/**
 * The argv that restores every tracked path the plan writes or deletes. It is printed, never run, and is
 * never a `git clean`: the consumer's untracked files can sit under a synced directory outside the paths the
 * preflight guards, and a clean deletes them unrecoverably where a checkout loses nothing.
 */
export const recoveryArgv = (plan: TargetPlan): string[] => {
  return ['git', '-C', plan.root, '--literal-pathspecs', 'checkout', 'HEAD', '--', ...plan.recoveryPaths]
}

/** Remove a leaf at `absolutePath`: a file or link is unlinked, an empty directory removed, absence ignored. */
const removeLeaf = (absolutePath: string): void => {
  const existing = fingerprintOnDisk(absolutePath)

  if (existing === null) return

  // rmdirSync refuses a non-empty directory, so a directory holding anything the plan did not account for
  // fails the target instead of being deleted.
  if (existing.kind === 'other') rmdirSync(absolutePath)
  else unlinkSync(absolutePath)
}

const writeOne = (sourceRoot: string, targetRoot: string, op: WriteOp): void => {
  const from = path.join(sourceRoot, op.source)
  const to = path.join(targetRoot, op.target)

  mkdirSync(path.dirname(to), { recursive: true })
  // Removing first means a link is never written through and a file-vs-link swap is a plain replace.
  removeLeaf(to)

  if (op.mode === '120000') {
    symlinkSync(readlinkSync(from), to)

    return
  }

  copyFileSync(from, to)
  chmodSync(to, op.mode === '100755' ? 0o755 : 0o644)
}

/**
 * Every directory that still holds a tracked path. The index keeps listing what this apply deleted until a
 * commit, so those entries do not count.
 */
const trackedDirectories = async (targetRoot: string, deleted: ReadonlySet<string>): Promise<Set<string>> => {
  const directories = new Set<string>()

  for (const trackedPath of splitNul(await runGit(targetRoot, ['ls-files', '-z']))) {
    if (deleted.has(trackedPath)) continue

    let dir = path.posix.dirname(trackedPath)

    while (dir !== '.') {
      directories.add(dir)
      dir = path.posix.dirname(dir)
    }
  }

  return directories
}

/**
 * Remove directories a delete left empty, walking up from each deleted path's parent and stopping at the repo
 * root, at a directory that still holds anything (ignored files included), or at one git still tracks.
 */
const pruneEmptyDirs = async (targetRoot: string, deleted: readonly string[]): Promise<void> => {
  if (deleted.length === 0) return

  const tracked = await trackedDirectories(targetRoot, new Set(deleted))
  const candidates = [
    ...new Set(
      deleted.map((deletedPath) => {
        return path.dirname(path.join(targetRoot, deletedPath))
      }),
    ),
  ]

  // Deepest first, so a parent is only examined after its children had their chance to go.
  candidates.sort((a, b) => {
    return b.length - a.length
  })

  for (const start of candidates) {
    let dir = start

    while (dir !== targetRoot && dir.startsWith(targetRoot)) {
      if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) break
      if (readdirSync(dir).length > 0 || tracked.has(path.relative(targetRoot, dir).split(path.sep).join('/'))) break

      rmdirSync(dir)
      dir = path.dirname(dir)
    }
  }
}

/**
 * The manifest's vendor-relative path set after an apply: every vendored entry's full source set plus
 * `README.md`, united with what the target's index tracks under `vendor/` minus what the apply deleted.
 *
 * The consumer-owned half keeps `vendor check` green on files the target tracks itself; the subtraction keeps
 * an uncommitted delete from being hashed off a missing file or recorded as present.
 */
export const manifestPathsAfterApply = (
  entries: readonly Pick<EntryPlan, 'targetPaths' | 'vendored'>[],
  trackedVendor: readonly string[],
  deleted: readonly string[],
): string[] => {
  const deletedSet = new Set(deleted)
  const fromSource = entries
    .filter((entry) => {
      return entry.vendored
    })
    .flatMap((entry) => {
      return entry.targetPaths
    })
  const surviving = trackedVendor.filter((trackedPath) => {
    return !deletedSet.has(trackedPath)
  })
  const relative = [...fromSource, VENDOR_README_PATH, ...surviving]
    .map(toVendorRelative)
    .filter((rel): rel is string => {
      return rel !== null && !isSkippedPath(rel)
    })

  return [...new Set(relative)].sort()
}

const writeVendorMeta = async (
  targetRoot: string,
  source: SourceIdentity,
  entries: readonly Pick<EntryPlan, 'targetPaths' | 'vendored'>[],
  deleted: readonly string[],
): Promise<void> => {
  const vendorRoot = path.join(targetRoot, VENDOR_DIR)

  mkdirSync(vendorRoot, { recursive: true })
  writeFileSync(path.join(targetRoot, VENDOR_README_PATH), vendorReadme(source.name))

  const paths = manifestPathsAfterApply(entries, await listTrackedVendorPaths(targetRoot), deleted)

  writeManifest(vendorRoot, { source: source.name, commit: source.headSha }, paths)
}

export interface ApplyOptions {
  source: SourceIdentity
  plan: TargetPlan
  /** Called once, before the first write to this target, so the recovery argv is on screen if the run dies. */
  onBeforeFirstWrite?: (argv: string[]) => void
}

/**
 * Apply one `changed` plan row: legacy paths first, then each entry's deletes and writes, then the README and
 * manifest when any entry is vendored. Deletes run before writes so a tracked file standing where the source
 * now has a directory is gone before that directory is created. Rows in any other status are a no-op.
 */
export const applyTargetPlan = async ({ source, plan, onBeforeFirstWrite }: ApplyOptions): Promise<ApplyResult> => {
  if (plan.status !== 'changed') return { touched: [], manifestWritten: false }

  onBeforeFirstWrite?.(recoveryArgv(plan))

  const targetRoot = path.resolve(plan.root)
  const deleted = [
    ...plan.legacy,
    ...plan.entries.flatMap((entry) => {
      return entry.deletes
    }),
  ]

  for (const deletedPath of deleted) removeLeaf(path.join(targetRoot, deletedPath))

  await pruneEmptyDirs(targetRoot, deleted)

  const writes = plan.entries.flatMap((entry) => {
    return entry.writes
  })

  for (const op of writes) writeOne(source.root, targetRoot, op)

  const written = writes.map((op) => {
    return op.target
  })

  if (!plan.writeVendorMeta) return { touched: [...new Set([...deleted, ...written])].sort(), manifestWritten: false }

  await writeVendorMeta(targetRoot, source, plan.entries, deleted)

  return {
    touched: [...new Set([...deleted, ...written, VENDOR_README_PATH, VENDOR_MANIFEST_PATH])].sort(),
    manifestWritten: true,
  }
}

/**
 * `--manifest-only`: rewrite the README and manifest from what the target's index tracks under `vendor/`,
 * copying nothing.
 */
export const writeVendorMetaOnly = async (targetRoot: string, source: SourceIdentity): Promise<string[]> => {
  await writeVendorMeta(targetRoot, source, [], [])

  return [VENDOR_README_PATH, VENDOR_MANIFEST_PATH]
}
