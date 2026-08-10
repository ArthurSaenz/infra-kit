/**
 * Zero-dependency resolver for the `#root/*` alias.
 *
 * Every tsconfig across the consuming monorepos maps `#root/*` to `./src/*` — 44 of them,
 * with no variants and no other alias — so the mapping is a convention we can implement
 * directly instead of reading it back out of tsconfig at lint time. That drops
 * `eslint-import-resolver-typescript` and its native `unrs-resolver` binary, and works the
 * same in packages that have no `paths` entry (or no tsconfig) at all.
 *
 * CommonJS on purpose: `eslint-module-utils/resolve.js` loads resolvers with a synchronous
 * `require(resolved)`, so an ESM module would not load cleanly.
 *
 * Contract (`eslint-module-utils`, interfaceVersion 2):
 *   resolve(source, file, config) -> { found: boolean, path?: string }
 * Returning `{ found: false }` hands the specifier to the next resolver in the chain, which
 * is how every non-`#root` import still reaches the node resolver.
 */

const fs = require('node:fs')
const path = require('node:path')

const ALIAS = '#root/'

/** Extensions tried for an extensionless specifier, TypeScript first. */
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']

/** package.json lookups are hot in a lint run over thousands of imports. */
const packageRootCache = new Map()

/** Same target is imported from many files; resolving it once is the bulk of the win. */
const resolutionCache = new Map()

/** Nearest ancestor directory containing a package.json, or null at the filesystem root. */
function findPackageRoot(startDir) {
  const cached = packageRootCache.get(startDir)
  if (cached !== undefined) return cached

  let dir = startDir

  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      packageRootCache.set(startDir, dir)
      return dir
    }

    const parent = path.dirname(dir)
    if (parent === dir) {
      packageRootCache.set(startDir, null)
      return null
    }

    dir = parent
  }
}

/**
 * `throwIfNoEntry: false` rather than try/catch: a miss is the common case here (up to one probe
 * per candidate extension per import), and throwing on every miss measured ~800ms slower across a
 * 60-feature corpus than returning undefined.
 */
const statOf = (candidate) => fs.statSync(candidate, { throwIfNoEntry: false })

const isFile = (candidate) => statOf(candidate)?.isFile() === true
const isDirectory = (candidate) => statOf(candidate)?.isDirectory() === true

/**
 * Applies node-style extension and directory-index resolution to an absolute base path.
 * Silent failure here would mean an unresolved import, which boundaries reports as nothing
 * at all — so each branch is covered by a test in __tests__/root-alias-resolver.test.ts.
 */
function resolveWithExtensions(base, extensions) {
  const cached = resolutionCache.get(base)
  if (cached !== undefined) return cached

  const resolved = resolveWithExtensionsUncached(base, extensions)
  resolutionCache.set(base, resolved)

  return resolved
}

function resolveWithExtensionsUncached(base, extensions) {
  if (isFile(base)) return base

  for (const extension of extensions) {
    const candidate = `${base}${extension}`
    if (isFile(candidate)) return candidate
  }

  if (isDirectory(base)) {
    for (const extension of extensions) {
      const candidate = path.join(base, `index${extension}`)
      if (isFile(candidate)) return candidate
    }
  }

  return null
}

/**
 * @param {string} source   the import specifier, e.g. `#root/features/billing`
 * @param {string} file     absolute path of the importing file
 * @param {{ alias?: string, baseDir?: string, extensions?: string[] }} [config]
 */
function resolve(source, file, config) {
  const alias = config?.alias ?? ALIAS
  const baseDir = config?.baseDir ?? 'src'
  const extensions = config?.extensions ?? DEFAULT_EXTENSIONS

  if (typeof source !== 'string' || !source.startsWith(alias)) return { found: false }

  const packageRoot = findPackageRoot(path.dirname(path.resolve(file)))
  if (!packageRoot) return { found: false }

  const target = path.join(packageRoot, baseDir, source.slice(alias.length))
  const resolved = resolveWithExtensions(target, extensions)

  return resolved ? { found: true, path: resolved } : { found: false }
}

module.exports = { interfaceVersion: 2, resolve }
