import { readFileSync } from 'node:fs'
import path from 'node:path'

import { runGit, splitNul } from './git'
import type { EntryScope, ModuleSelection, SourceEntryFacts } from './types'

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

/**
 * The module names the source declares, sorted.
 *
 * @example
 * knownModules(entries) // => ['auth', 'web-toolkit']
 */
export const knownModules = (entries: readonly SourceEntryFacts[]): string[] => {
  const names = entries.flatMap(({ entry }) => {
    return entry.module === null ? [] : [entry.module]
  })

  return [...new Set(names)].sort()
}

/**
 * How each source entry reaches one target, index-aligned with `entries`. A module the target did not select
 * is pruned under `vendor/`, where the sync owns every file, and released outside it, where the repo may have
 * made the file its own. Returns the reason instead when the selection cannot be honoured.
 *
 * @example
 * entryScopes(entries, { kind: 'modules', modules: [] }) // => ['sync', 'prune', 'release']
 */
export const entryScopes = (
  entries: readonly SourceEntryFacts[],
  selection: ModuleSelection,
): EntryScope[] | { reason: string } => {
  if (selection.kind === 'invalid') return { reason: selection.reason }

  const known = knownModules(entries)

  if (selection.kind === 'modules') {
    const unknown = selection.modules.filter((name) => {
      return !known.includes(name)
    })

    if (unknown.length > 0) {
      const offered = known.length > 0 ? known.join(', ') : 'none'

      return {
        reason: `unknown module(s) ${unknown.join(', ')} in vendorTarget.modules; the source offers: ${offered}`,
      }
    }
  }

  return entries.map(({ entry }): EntryScope => {
    if (entry.module === null || selection.kind === 'all' || selection.modules.includes(entry.module)) return 'sync'

    return entry.vendored ? 'prune' : 'release'
  })
}

const readJson = (filePath: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

// Only a package's own manifest names it; a nested fixture or template package.json deeper down does not.
const packageNamesOf = (sourceRoot: string, facts: SourceEntryFacts): string[] => {
  return facts.files.flatMap((file) => {
    const rel = path.posix.relative(facts.entry.path, file.path)

    if (path.posix.basename(rel) !== 'package.json' || rel.split('/').length > 2) return []

    const name = readJson(path.join(sourceRoot, file.path))?.name

    return typeof name === 'string' ? [name] : []
  })
}

const dependencyNames = (manifest: Record<string, unknown>): string[] => {
  return DEPENDENCY_FIELDS.flatMap((field) => {
    const deps = manifest[field]

    return deps !== null && typeof deps === 'object' ? Object.keys(deps) : []
  })
}

/**
 * One line per target `package.json` that still depends on a package the prune would delete. A pruned
 * workspace package would otherwise leave a `workspace:` dependency nothing satisfies, and the target would
 * only find out at its next `pnpm install`.
 */
export const pruneConflicts = async (
  sourceRoot: string,
  targetRoot: string,
  pruned: readonly { facts: SourceEntryFacts; target: string }[],
): Promise<string[]> => {
  const owners = new Map<string, string>()

  for (const { facts } of pruned) {
    for (const name of packageNamesOf(sourceRoot, facts)) owners.set(name, facts.entry.module ?? '')
  }

  if (owners.size === 0) return []

  const prunedRoots = pruned.map(({ target }) => {
    return `${target}/`
  })
  const manifests = splitNul(await runGit(targetRoot, ['ls-files', '-z', '--', '*package.json'])).filter((rel) => {
    const inPruned = prunedRoots.some((prefix) => {
      return rel.startsWith(prefix)
    })

    return path.posix.basename(rel) === 'package.json' && !inPruned
  })

  return manifests.flatMap((rel) => {
    const manifest = readJson(path.join(targetRoot, rel))

    if (manifest === null) return []

    return dependencyNames(manifest)
      .filter((dep) => {
        return owners.has(dep)
      })
      .map((dep) => {
        return `${rel} depends on ${dep}: add "${owners.get(dep)}" to vendorTarget.modules or drop the dependency`
      })
  })
}
