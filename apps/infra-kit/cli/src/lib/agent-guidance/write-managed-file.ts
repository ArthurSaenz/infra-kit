import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { hasManagedBlock } from 'src/lib/managed-block'

/**
 * What a managed write did to one file.
 *
 * `failed` carries the continue-and-report policy (§3.6): a per-file error is recorded against
 * that path and the run proceeds, because aborting halfway can leave exactly one well-formed
 * block behind — which adopts the workspace and reddens every package the run never reached.
 */
export type WriteAction = 'created' | 'updated' | 'unchanged' | 'removed' | 'failed'

/**
 * When to write a `<file>.backup.<timestamp>` sibling before overwriting.
 *
 * - `always` — the repo-root file's policy. One backup per deliberate `init` run.
 * - `git-aware` — the package-file policy: back up only when git could not recover the file
 *   (untracked, dirty, or outside a git repo). A fix run touches 27–36 files, so an
 *   unconditional backup there is a noise problem the root file does not have.
 */
export type BackupPolicy = 'always' | 'git-aware'

/** Whether git can recover the current bytes of a file if we overwrite them. */
export type GitState = 'tracked-clean' | 'needs-backup'

/**
 * Refuse to write through a symlink. Gates on `lstatSync` inside a try/catch rather than
 * `existsSync`: `existsSync` *follows* links, so a **dangling** symlink reports `false`, the
 * symlink branch is never reached, and the write goes through the link — creating a file
 * outside the repo. Any stat failure (ENOENT for a plain absent file) is fine and returns.
 *
 * @example
 * assertNotSymlink('/repo/CLAUDE.md')
 * // returns silently when the path is absent or a regular file; throws when it is a symlink
 */
export const assertNotSymlink = (filePath: string): void => {
  let stats: fs.Stats

  try {
    stats = fs.lstatSync(filePath)
  } catch {
    return
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to write ${filePath} because the destination is a symlink`)
  }
}

/**
 * Copy a file to a timestamped `<file>.backup.<timestamp>` sibling.
 *
 * @example
 * backupFile('/repo/CLAUDE.md')
 * // writes /repo/CLAUDE.md.backup.2026-09-05T10-11-12-000Z
 */
export const backupFile = (filePath: string): void => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  fs.copyFileSync(filePath, `${filePath}.backup.${stamp}`)
}

interface GitIndex {
  /** Absolute, symlink-resolved repository root. */
  root: string
  /** Repo-relative paths git tracks. */
  tracked: Set<string>
  /** Repo-relative paths `git status --porcelain` reports as changed in any way. */
  dirty: Set<string>
}

/** Resolved repo root per starting directory; `null` means "not a git repo". */
const rootByDir = new Map<string, string | null>()
/** One `ls-files` + one `status` per repo root, for the life of the process. */
const indexByRoot = new Map<string, GitIndex>()

/**
 * Clear the cached `git ls-files` / `git status` snapshots. Tests only — inside one CLI run
 * the working tree does not change underneath us, and re-running two subprocesses per file
 * is the cost this cache exists to avoid.
 *
 * @example
 * resetGitStateCache()
 * // the next classifyGitState() call shells out to git again
 */
export const resetGitStateCache = (): void => {
  rootByDir.clear()
  indexByRoot.clear()
}

/** Run a git command in `cwd`, returning its stdout, or `null` when git fails or is absent. */
const runGit = (cwd: string, args: string[]): string | null => {
  try {
    // `git` off PATH, matching every other git call in this CLI (see `dev/dev-server.ts`):
    // the tool is whatever the developer's shell resolves, and pinning an absolute path here
    // would break every non-Homebrew install.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** Split a NUL-delimited git output into its non-empty fields. */
const nulFields = (output: string): string[] => {
  return output.split('\0').filter((field) => {
    return field !== ''
  })
}

/**
 * Paths named by `git status --porcelain -z`. Each record is `XY <path>`; a rename or copy
 * adds the original path as its own following field. Both are collected — a rename origin in
 * the dirty set only ever errs toward writing a backup, which is the safe direction.
 */
const dirtyPaths = (output: string): Set<string> => {
  const paths = nulFields(output).map((field) => {
    const match = field.match(/^.. (.*)$/s)

    return match ? match[1]! : field
  })

  return new Set(paths)
}

/** The git repo root for `dir`, symlink-resolved, or `null` when `dir` is not in a repo. */
const resolveGitRoot = (dir: string): string | null => {
  const memoized = rootByDir.get(dir)

  if (memoized !== undefined) return memoized

  const output = runGit(dir, ['rev-parse', '--show-toplevel'])
  let root: string | null = null

  if (output !== null) {
    try {
      root = fs.realpathSync(output.trim())
    } catch {
      root = output.trim()
    }
  }

  rootByDir.set(dir, root)

  return root
}

/** The tracked/dirty snapshot for the repo containing `dir`, or `null` outside a repo. */
const loadGitIndex = (dir: string): GitIndex | null => {
  const root = resolveGitRoot(dir)

  if (root === null) return null

  const memoized = indexByRoot.get(root)

  if (memoized) return memoized

  const trackedOutput = runGit(root, ['ls-files', '-z'])
  const statusOutput = runGit(root, ['status', '--porcelain', '-z'])

  const index: GitIndex = {
    root,
    tracked: new Set(trackedOutput === null ? [] : nulFields(trackedOutput)),
    dirty: statusOutput === null ? new Set<string>() : dirtyPaths(statusOutput),
  }

  indexByRoot.set(root, index)

  return index
}

/**
 * `filePath` expressed the way git names it: relative to the repo root, `/`-separated, with
 * the directory symlink-resolved. macOS hands out `/var/folders/…` temp paths that git reports
 * as `/private/var/folders/…`, so comparing an unresolved path against a resolved root never
 * matches and every file would look untracked.
 */
const repoRelativePath = (root: string, filePath: string): string | null => {
  let realDir: string

  try {
    realDir = fs.realpathSync(path.dirname(filePath))
  } catch {
    return null
  }

  const relative = path.relative(root, path.join(realDir, path.basename(filePath)))

  if (relative === '' || relative.startsWith('..')) return null

  return relative.split(path.sep).join('/')
}

/**
 * Whether git holds a clean, tracked copy of `filePath` — i.e. whether overwriting it is
 * recoverable without a backup. Untracked, dirty, and not-a-git-repo all answer `needs-backup`.
 * One `git ls-files` plus one `git status` per repo root serves every file in a run.
 *
 * @example
 * classifyGitState('/repo/apps/client/ui/CLAUDE.md')
 * // => 'tracked-clean'  (committed and unmodified)
 * @example
 * classifyGitState('/tmp/loose/CLAUDE.md')
 * // => 'needs-backup'   (outside any git repo)
 */
export const classifyGitState = (filePath: string): GitState => {
  const index = loadGitIndex(path.dirname(filePath))

  if (index === null) return 'needs-backup'

  const relative = repoRelativePath(index.root, filePath)

  if (relative === null || !index.tracked.has(relative)) return 'needs-backup'

  return index.dirty.has(relative) ? 'needs-backup' : 'tracked-clean'
}

export interface WriteManagedOptions {
  /** Backup policy for this file. `always` for the repo root, `git-aware` for package files. */
  backup: BackupPolicy
}

/** Whether a backup must be written before overwriting an existing file. */
const shouldBackup = (filePath: string, policy: BackupPolicy): boolean => {
  return policy === 'always' || classifyGitState(filePath) !== 'tracked-clean'
}

/**
 * Write `next` to `filePath` with the OMC-style safety rails: refuse symlinks, skip the write
 * entirely when the bytes are identical (so re-runs are churn-free), and back up the prior
 * file according to `backup` before overwriting.
 *
 * @example
 * writeManaged('/repo/CLAUDE.md', body, { backup: 'always' })
 * // => 'created' | 'updated' | 'unchanged'
 */
export const writeManaged = (filePath: string, next: string, { backup }: WriteManagedOptions): WriteAction => {
  assertNotSymlink(filePath)

  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null

  if (previous === next) return 'unchanged'

  if (previous !== null && shouldBackup(filePath, backup)) backupFile(filePath)

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, next, 'utf-8')

  return previous === null ? 'created' : 'updated'
}

/**
 * Post-write assertion: the managed block really is in the file we just wrote.
 *
 * @example
 * assertBlockPresent('/repo/CLAUDE.md', ROOT_MARKER_START, ROOT_MARKER_END)
 * // throws when the block is missing from the file on disk
 */
export const assertBlockPresent = (filePath: string, start: string, end: string): void => {
  const content = fs.readFileSync(filePath, 'utf-8')

  if (!hasManagedBlock(content, start, end)) {
    throw new Error(`Post-write validation failed: managed block missing from ${filePath}`)
  }
}

/** The text before the start marker and after the end marker, or `null` when there is no block. */
const outsideMarkers = (content: string, start: string, end: string): { before: string; after: string } | null => {
  if (!hasManagedBlock(content, start, end)) return null

  return {
    before: content.slice(0, content.indexOf(start)),
    after: content.slice(content.indexOf(end) + end.length),
  }
}

/**
 * Post-write assertion for the **replace-in-place** path only: every byte outside the markers
 * survived the update untouched.
 *
 * First insertion is deliberately exempt and must not be checked here. `upsertManagedBlock`'s
 * non-replace path collapses a trailing run of blank lines and appends a newline, so a file
 * that ends in blank lines legitimately changes outside the markers the first time a block
 * lands in it. After that, byte-identity is true and worth pinning.
 *
 * @example
 * assertOutsideMarkersUnchanged(before, after, ROOT_MARKER_START, ROOT_MARKER_END)
 * // throws when hand-authored text around the block was altered
 */
export const assertOutsideMarkersUnchanged = (before: string, after: string, start: string, end: string): void => {
  const previous = outsideMarkers(before, start, end)
  const next = outsideMarkers(after, start, end)

  if (previous === null || next === null) return

  if (previous.before !== next.before || previous.after !== next.after) {
    throw new Error('Post-write validation failed: content outside the managed markers changed')
  }
}
