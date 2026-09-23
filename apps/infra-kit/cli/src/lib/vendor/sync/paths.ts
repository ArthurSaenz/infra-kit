import path from 'node:path'

import { MANIFEST_FILE } from '../manifest'
import { VENDOR_DIR } from '../skip-sets'
import type { CopyEntry, ResolvedCopyEntry, SyncSpec } from './types'

const VENDOR_PREFIX = `${VENDOR_DIR}/`

export const VENDOR_README_PATH = `${VENDOR_DIR}/README.md`
export const VENDOR_MANIFEST_PATH = `${VENDOR_DIR}/${MANIFEST_FILE}`

/**
 * Whether a target path is vendored, i.e. covered by the integrity manifest.
 *
 * @example
 * isVendoredTarget('vendor/configs') // => true
 * isVendoredTarget('.claude')        // => false
 */
export const isVendoredTarget = (target: string): boolean => {
  return target.startsWith(VENDOR_PREFIX)
}

// Belt and braces only: the config schema refuses every non-canonical spelling. `rebasePath` slices by length
// and `git ls-files` prints canonical paths, so `tools/x/` or `./vendor/x` would silently mismatch.
const toCanonical = (repoPath: string): string => {
  const normalized = path.posix.normalize(repoPath)

  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

/**
 * Fill in each entry's default target and its vendored flag.
 *
 * @example
 * resolveCopyEntry({ path: 'vendor/configs' }) // => { path: 'vendor/configs', target: 'vendor/configs', vendored: true }
 */
export const resolveCopyEntry = (entry: CopyEntry): ResolvedCopyEntry => {
  const source = toCanonical(entry.path)
  const target = entry.target === undefined ? source : toCanonical(entry.target)

  return { path: source, target, vendored: isVendoredTarget(target) }
}

/** The sync's only entry point into a spec, so every path it probes, diffs or writes is canonical. */
export const resolveCopyEntries = (spec: SyncSpec): ResolvedCopyEntry[] => {
  return spec.copy.map(resolveCopyEntry)
}

/**
 * Whether any segment of a repo-relative path is an excluded name.
 *
 * @example
 * hasExcludedSegment('vendor/configs/serverless-config/a.ts', ['serverless-config']) // => true
 */
export const hasExcludedSegment = (relativePath: string, exclude: readonly string[]): boolean => {
  if (exclude.length === 0) return false

  return relativePath.split('/').some((segment) => {
    return exclude.includes(segment)
  })
}

/** Generic over the item so the source's fingerprinted files and the target's tracked files share one rule. */
export const withoutExcluded = <T extends { path: string }>(items: readonly T[], exclude: readonly string[]): T[] => {
  return items.filter((item) => {
    return !hasExcludedSegment(item.path, exclude)
  })
}

/**
 * Move a source-set path from under the entry's `path` to under its `target`.
 *
 * @example
 * rebasePath('tools/x/a.ts', { path: 'tools/x', target: 'vendor/x', vendored: true }) // => 'vendor/x/a.ts'
 */
export const rebasePath = (sourcePath: string, entry: ResolvedCopyEntry): string => {
  if (sourcePath === entry.path) return entry.target

  return `${entry.target}${sourcePath.slice(entry.path.length)}`
}

export const uniqueSorted = (paths: Iterable<string>): string[] => {
  return [...new Set(paths)].sort()
}

/**
 * Strip the `vendor/` prefix, or `null` for a path outside it.
 *
 * @example
 * toVendorRelative('vendor/configs/a.ts') // => 'configs/a.ts'
 */
export const toVendorRelative = (repoPath: string): string | null => {
  return repoPath.startsWith(VENDOR_PREFIX) ? repoPath.slice(VENDOR_PREFIX.length) : null
}
