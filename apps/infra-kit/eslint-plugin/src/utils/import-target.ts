import type { Rule } from 'eslint'
import path from 'node:path'

import { findPackageRoot } from './package-root'
import { resolvePackageType } from './package-type-reader'
import { matchesAnyGlob } from './path-match'

export const DEFAULT_ROOT_ALIAS = '#root'

const INDEX_FILE = /^index(?:\.[cm]?[jt]sx?)?$/

/** An import-like node whose module path is a string literal, with the literal node to report on. */
export interface ImportSource {
  specifier: string
  node: Rule.Node
  typeOnly: boolean
}

interface SourceLiteral {
  type: string
  value?: unknown
  literal?: { value?: unknown }
}

const literalValue = (source: SourceLiteral | null | undefined): string | null => {
  if (source === null || source === undefined) {
    return null
  }

  // `typeof import('x')` wraps the literal in a TSLiteralType; every other carrier holds it directly.
  const value = source.type === 'TSLiteralType' ? source.literal?.value : source.value

  return typeof value === 'string' ? value : null
}

interface SpecifierLike {
  importKind?: string
  exportKind?: string
}

const allSpecifiersAreTypes = (specifiers: readonly SpecifierLike[] | undefined, key: keyof SpecifierLike): boolean => {
  return (
    specifiers !== undefined &&
    specifiers.length > 0 &&
    specifiers.every((specifier) => {
      return specifier[key] === 'type'
    })
  )
}

interface ImportLikeNode {
  type: string
  source?: SourceLiteral | null
  argument?: SourceLiteral
  importKind?: string
  exportKind?: string
  specifiers?: SpecifierLike[]
}

/**
 * The module path an import-like node names, or null for a node without a static string path
 * (`import(name)`, a template literal, a local `export { a }`). `typeof import('x')` counts and is
 * type-only: hulyo reaches into feature internals that way, past every import-statement rule.
 */
export const readImportSource = (node: Rule.Node): ImportSource | null => {
  const candidate = node as unknown as ImportLikeNode
  // typescript-eslint 8 moved TSImportType's path from `argument` to `source`; read either.
  const sourceNode = candidate.type === 'TSImportType' ? (candidate.source ?? candidate.argument) : candidate.source
  const specifier = literalValue(sourceNode)

  if (specifier === null || sourceNode === null || sourceNode === undefined) {
    return null
  }

  const typeOnly =
    candidate.type === 'TSImportType' ||
    candidate.importKind === 'type' ||
    candidate.exportKind === 'type' ||
    allSpecifiersAreTypes(candidate.specifiers, candidate.type === 'ImportDeclaration' ? 'importKind' : 'exportKind')

  return { specifier, node: sourceNode as unknown as Rule.Node, typeOnly }
}

/** The `src` directory of the package `filename` lives in, or null when it is not under one. */
export const srcDirOf = (filename: string): string | null => {
  const packageRoot = findPackageRoot(filename)

  if (packageRoot !== null) {
    return filename.startsWith(`${packageRoot}/src/`) ? `${packageRoot}/src` : null
  }

  // Virtual filenames (RuleTester, `<input>`) have no package on disk: the innermost `src/` stands in.
  const index = filename.lastIndexOf('/src/')

  return index >= 0 ? filename.slice(0, index + '/src'.length) : null
}

/**
 * Where `specifier` points, as the path segments under `srcDir` — `['features', 'user']` for
 * `#root/features/user` or `../../features/user`. Null for a package import, another alias, or a
 * relative path that climbs out of `src/`: those have no layer.
 */
export const resolveUnderSrc = (
  filename: string,
  srcDir: string,
  specifier: string,
  rootAlias: string,
): string[] | null => {
  let absolute: string

  if (specifier === rootAlias || specifier.startsWith(`${rootAlias}/`)) {
    absolute = path.posix.join(srcDir, specifier.slice(rootAlias.length))
  } else if (specifier.startsWith('.')) {
    absolute = path.posix.resolve(path.posix.dirname(filename), specifier)
  } else {
    return null
  }

  if (!absolute.startsWith(`${srcDir}/`)) {
    return null
  }

  return absolute.slice(srcDir.length + 1).split('/')
}

/** Path segments of `filename`'s directory under `srcDir`. */
export const fileDirsUnderSrc = (filename: string, srcDir: string): string[] => {
  return filename
    .slice(srcDir.length + 1)
    .split('/')
    .slice(0, -1)
}

/** `features/<name>` or `features/<name>/index.*` — the only paths that form a feature's public API. */
export const isFeaturePublicApi = (target: readonly string[]): boolean => {
  return target.length === 2 || (target.length === 3 && INDEX_FILE.test(target[2]!))
}

/** The feature name a src-relative path sits in (`features/<name>/…`), or null outside `features/`. */
export const featureNameOf = (segments: readonly string[]): string | null => {
  return segments[0] === 'features' && segments.length >= 2 ? segments[1]! : null
}

/**
 * Every node kind that names a module: static imports, re-exports, dynamic `import('x')` and the
 * type-level `typeof import('x')`. A rule registers one handler for all of them.
 */
export const IMPORT_SELECTORS = [
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
  'ImportExpression',
  'TSImportType',
] as const

// Backends and Playwright suites have no UI layering; their `src/` folders mean something else.
const UNLAYERED_TYPES = new Set(['backend', 'e2e'])

/** Whether the src-layout import rules apply to `filename`: not ignored, not in a backend or e2e package. */
export const isLayeredFile = (filename: string, ignore: readonly string[]): boolean => {
  if (ignore.length > 0 && matchesAnyGlob(filename, ignore)) {
    return false
  }

  const packageRoot = findPackageRoot(filename)

  return packageRoot === null || !UNLAYERED_TYPES.has(resolvePackageType(packageRoot))
}
