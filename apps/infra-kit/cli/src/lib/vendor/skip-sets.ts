/**
 * Skip rules for walking a `vendor/` tree to build or verify its integrity
 * manifest. This is the SINGLE source of truth consumed by both the read path
 * (`vendor check`) and the write path (`vendor sync`/`manifest`).
 *
 * The set below is a strict superset of the legacy read script's
 * `MANIFEST_SKIP_DIRS` (`scripts/vendor-check.mjs`). It additionally skips
 * `.vitest-attachments` — a git-ignored directory (see repo `.gitignore`) that
 * therefore never appears in a committed vendor tree. Widening the read path's
 * skip set this way is deliberate and behavior-preserving: no existing manifest
 * changes, and the read and write paths share this single set so they cannot
 * diverge.
 */
/** Root of the mirrored tree inside each repo. Single source for read + write paths. */
export const VENDOR_DIR = 'vendor'

export const MANIFEST_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.turbo',
  '.omc',
  '__screenshots__',
  '.vitest-attachments',
  '.output',
  '.source',
  '.nitro',
  '.tanstack',
])

/**
 * `routeTree.gen.ts` is written by the TanStack Router generator on every dev
 * run and build. Its route order is not stable across machines, so a consumer
 * that merely opens the docs app rewrites the file into an equivalent-but-
 * different form and trips the integrity check on a file nobody edited. It is
 * still mirrored by the sync (a fresh consumer needs it for `tsc --noEmit`);
 * only its checksum is untracked.
 */
export const MANIFEST_SKIP_FILES: ReadonlySet<string> = new Set([
  '.sync-manifest.json',
  '.eslintcache',
  'log.txt',
  'routeTree.gen.ts',
])

export const MANIFEST_SKIP_SUFFIXES: readonly string[] = ['.tsbuildinfo']

/** Whether a directory name should be skipped when walking the vendor tree. */
export const isSkippedDir = (name: string): boolean => {
  return MANIFEST_SKIP_DIRS.has(name)
}

/** Whether a file name should be skipped when walking the vendor tree. */
export const isSkippedFile = (name: string): boolean => {
  if (MANIFEST_SKIP_FILES.has(name)) {
    return true
  }

  return MANIFEST_SKIP_SUFFIXES.some((suffix) => {
    return name.endsWith(suffix)
  })
}

/**
 * Whether a POSIX-relative path inside the vendor tree is skipped — the same
 * rules `walkVendorTree` applies, but expressed over a recorded path instead of
 * a live directory entry.
 *
 * This is what lets a skip rule be ADDED without reissuing every manifest: a
 * manifest written before the rule still lists the path, the walk no longer
 * emits it, and without this filter the comparison would report a phantom
 * "removed" for a file that is sitting right there.
 */
export const isSkippedPath = (relativePath: string): boolean => {
  const segments = relativePath.split('/')
  const name = segments.pop() ?? ''

  const inSkippedDir = segments.some((segment) => {
    return isSkippedDir(segment)
  })

  return inSkippedDir || isSkippedFile(name)
}
