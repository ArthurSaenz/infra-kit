import type { PackageType, PackageTypeManifest } from '@slip-stream-kit/config/package-type'
import { PACKAGE_TYPES, detectPackageType } from '@slip-stream-kit/config/package-type'
import fs from 'node:fs'
import path from 'node:path'

import { CONFIG_FILENAME, findRepoRoot } from './package-root'

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
// Full-line `//` comments only: a trailing `//` after code is left alone so the `https://` inside
// every consumer's `templates.cloud` string value survives the strip. Indentation is `[ \t]`, not
// `\s`, because under the `m` flag `\s*` spans line breaks and backtracks super-linearly.
const FULL_LINE_COMMENT = /^[ \t]*\/\/.*$/gm
// Built from PACKAGE_TYPES so a sixth type added to the config package cannot escape the reader.
const DECLARED_TYPE = new RegExp(`(?:^|[\\s{,])type:\\s*['"](${PACKAGE_TYPES.join('|')})['"]`, 'm')

/**
 * The literal `type` declared in an `infra-kit.config.ts` source text, or undefined when it is
 * absent, computed, or not one of the known types.
 *
 * The config is read as text rather than imported: `require(esm)` is cached by the ESM loader, so a
 * rewritten config would keep returning its old value, and importing it would execute consumer code
 * (and its zod import) inside the ESLint process. Comments are stripped first so a commented-out
 * `// type: 'backend'` above the live literal cannot win; the first live match does.
 */
export const readDeclaredType = (text: string): PackageType | undefined => {
  const stripped = text.replace(BLOCK_COMMENT, '').replace(FULL_LINE_COMMENT, '')
  const literal = DECLARED_TYPE.exec(stripped)?.[1]

  return PACKAGE_TYPES.find((candidate) => {
    return candidate === literal
  })
}

interface CachedType {
  /** `-1` when the config file is absent, so its later creation is a cache miss like any edit. */
  mtimeMs: number
  type: PackageType
}

const typeCache = new Map<string, CachedType>()

const configMtimeMs = (configPath: string): number => {
  try {
    return fs.statSync(configPath).mtimeMs
  } catch {
    return -1
  }
}

const readManifest = (manifestPath: string): PackageTypeManifest => {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PackageTypeManifest
  } catch {
    return {}
  }
}

/**
 * The package's type: the literal declared in its `infra-kit.config.ts` when there is one, else the
 * CLI's inference from directory and dependency signals.
 *
 * One `statSync` on the config per call is the steady-state cost; the text is re-read only when the
 * mtime moved, so a config edit is seen by the next lint of any file in the package — in a CLI run
 * or a long-lived IDE server alike. `package.json` is read once per root and never revalidated: it
 * only feeds the dependency fallback, and a dependency change is a `pnpm install` event, not an
 * edit-lint loop.
 */
export const resolvePackageType = (packageRoot: string): PackageType => {
  const configPath = path.posix.join(packageRoot, CONFIG_FILENAME)
  const mtimeMs = configMtimeMs(configPath)
  const hit = typeCache.get(packageRoot)

  if (hit !== undefined && hit.mtimeMs === mtimeMs) {
    return hit.type
  }

  const declaredType = mtimeMs >= 0 ? readDeclaredType(fs.readFileSync(configPath, 'utf8')) : undefined
  const type = detectPackageType({
    packageDir: packageRoot,
    repoRoot: findRepoRoot(packageRoot) ?? packageRoot,
    pkgJson: readManifest(path.posix.join(packageRoot, 'package.json')),
    declaredType,
  })

  typeCache.set(packageRoot, { mtimeMs, type })

  return type
}

/** Drops the root → type memo; only tests that build and tear down fixture trees need this. */
export const resetPackageTypeCache = (): void => {
  typeCache.clear()
}
