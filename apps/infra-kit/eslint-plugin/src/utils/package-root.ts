import fs from 'node:fs'
import path from 'node:path'

export const CONFIG_FILENAME = 'infra-kit.config.ts'
const PACKAGE_MARKERS = [CONFIG_FILENAME, 'package.json']
const REPO_MARKERS = ['pnpm-workspace.yaml']

const hasAnyMarker = (dir: string, markers: readonly string[]): boolean => {
  return markers.some((marker) => {
    return fs.existsSync(path.posix.join(dir, marker))
  })
}

// The steady-state cost of the rule is one `statSync` per linted file (see package-type-reader), so
// the directory walk must not add a stat per ancestor per file: every dirname seen resolves to its
// package root once per lint process.
const rootCache = new Map<string, string | null>()

/** Nearest ancestor of `startDir` (inclusive) that holds one of `markers`, or null at the fs root. */
const findUp = (startDir: string, markers: readonly string[]): string | null => {
  let current = startDir

  while (!hasAnyMarker(current, markers)) {
    const parent = path.posix.dirname(current)

    if (parent === current) {
      return null
    }

    current = parent
  }

  return current
}

/**
 * The package directory a linted file belongs to: the nearest ancestor holding `infra-kit.config.ts`
 * or `package.json`. Null for virtual / relative filenames, which have no place on disk to walk from.
 */
export const findPackageRoot = (filename: string): string | null => {
  // ESLint hands rules `<input>` / `<text>` for virtual sources; there is nothing to walk up from.
  if (!path.posix.isAbsolute(filename)) {
    return null
  }

  const dir = path.posix.dirname(filename)
  const cached = rootCache.get(dir)

  if (cached !== undefined) {
    return cached
  }

  const root = findUp(dir, PACKAGE_MARKERS)

  rootCache.set(dir, root)

  return root
}

/**
 * The directory names between `<packageRoot>/src/` and `filename`, outermost first — `[]` for a
 * file directly in `src/`, null when the file is not under `src/` at all (so `dist/src/x/...`,
 * built output a consumer ships, is null too).
 */
export const dirsUnderSrc = (packageRoot: string, filename: string): string[] | null => {
  const srcPrefix = `${packageRoot}/src/`

  if (!filename.startsWith(srcPrefix)) {
    return null
  }

  return filename.slice(srcPrefix.length).split('/').slice(0, -1)
}

/** Nearest ancestor of `packageRoot` (inclusive) that is a pnpm workspace root, or null outside one. */
export const findRepoRoot = (packageRoot: string): string | null => {
  return findUp(packageRoot, REPO_MARKERS)
}

/** Drops the dirname → root memo; only tests that build and tear down fixture trees need this. */
export const resetPackageRootCache = (): void => {
  rootCache.clear()
}
