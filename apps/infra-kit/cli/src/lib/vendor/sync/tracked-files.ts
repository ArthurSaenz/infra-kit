import { VENDOR_DIR } from '../skip-sets'
import { runGit, splitNul } from './git'
import { hasExcludedSegment } from './paths'
import type { GitFileMode, TrackedFile } from './types'

const COPYABLE_MODES: ReadonlySet<string> = new Set<GitFileMode>(['100644', '100755', '120000'])

/**
 * Parse `git ls-files -z -s` records (`<mode> <oid> <stage>\t<path>`) into copyable files.
 *
 * Gitlinks are dropped because a submodule has no bytes to copy, and paths are de-duplicated because an
 * unmerged path is listed once per stage.
 *
 * @example
 * parseLsFilesStage('100755 abc 0\tbin/run\0', []) // => [{ path: 'bin/run', mode: '100755' }]
 */
export const parseLsFilesStage = (stdout: string, exclude: readonly string[]): TrackedFile[] => {
  const byPath = new Map<string, TrackedFile>()

  for (const record of splitNul(stdout)) {
    const tab = record.indexOf('\t')
    const mode = record.slice(0, record.indexOf(' '))
    const filePath = record.slice(tab + 1)

    if (tab < 0 || !COPYABLE_MODES.has(mode) || hasExcludedSegment(filePath, exclude)) continue

    byPath.set(filePath, { path: filePath, mode: mode as GitFileMode })
  }

  return [...byPath.values()]
}

/**
 * Tracked files under one repo-relative path, minus excluded segments. Runs the same way on the source and
 * on a target, which is what makes excludes symmetric.
 */
export const listTrackedFiles = async (
  repoRoot: string,
  relativePath: string,
  exclude: readonly string[],
): Promise<TrackedFile[]> => {
  const stdout = await runGit(repoRoot, ['--literal-pathspecs', 'ls-files', '-z', '-s', '--', relativePath])

  return parseLsFilesStage(stdout, exclude)
}

/**
 * Repo-relative paths the target's index lists under `vendor/`.
 *
 * This reads the INDEX, so after an uncommitted apply it still lists files the apply deleted; callers
 * subtract the delete set before hashing.
 */
export const listTrackedVendorPaths = async (repoRoot: string): Promise<string[]> => {
  return splitNul(await runGit(repoRoot, ['--literal-pathspecs', 'ls-files', '-z', '--', VENDOR_DIR]))
}
