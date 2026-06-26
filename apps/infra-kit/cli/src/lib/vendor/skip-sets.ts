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

export const MANIFEST_SKIP_FILES: ReadonlySet<string> = new Set(['.sync-manifest.json', '.eslintcache', 'log.txt'])

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
