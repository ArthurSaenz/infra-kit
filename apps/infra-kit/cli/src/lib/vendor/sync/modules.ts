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

// A trailing word character or "-" means a longer name that merely starts with this one.
const mentions = (text: string, name: string): boolean => {
  let at = text.indexOf(name)

  while (at >= 0) {
    if (!/[\w-]/.test(text[at + name.length] ?? '')) return true

    at = text.indexOf(name, at + 1)
  }

  return false
}

// Shell and CI files are where a deploy names a package it builds; prose files are left out because a
// README mentioning a package is not a use of it.
const RUNNER_PATHSPECS = ['*.sh', '*.yml', '*.yaml']

const manifestUses = (rel: string, manifest: Record<string, unknown>, name: string): string[] => {
  const uses = dependencyNames(manifest).includes(name) ? [`${rel} depends on ${name}`] : []
  const scripts = manifest.scripts !== null && typeof manifest.scripts === 'object' ? manifest.scripts : {}

  for (const [script, command] of Object.entries(scripts)) {
    if (typeof command === 'string' && mentions(command, name)) uses.push(`${rel} script "${script}" runs ${name}`)
  }

  return uses
}

const runnerUses = async (targetRoot: string, name: string, outside: (rel: string) => boolean): Promise<string[]> => {
  const args = ['grep', '-z', '-l', '-F', '-e', name, '--', ...RUNNER_PATHSPECS]
  const files = splitNul(await runGit(targetRoot, args, { allowFailure: true }))

  return files
    .filter((rel) => {
      return outside(rel) && mentions(readFileSync(path.join(targetRoot, rel), 'utf8'), name)
    })
    .map((rel) => {
      return `${rel} uses ${name}`
    })
}

/**
 * One line per place in the target that still uses a package the prune would delete: a `package.json`
 * dependency or script, or a shell or CI file that names it. Deleting the package would otherwise leave the
 * target broken in a way it only finds out at its next install, dev run or deploy.
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
  const outsidePruned = (rel: string): boolean => {
    return !prunedRoots.some((prefix) => {
      return rel.startsWith(prefix)
    })
  }
  const manifests = splitNul(await runGit(targetRoot, ['ls-files', '-z', '--', '*package.json'])).filter((rel) => {
    return path.posix.basename(rel) === 'package.json' && outsidePruned(rel)
  })
  const conflicts: string[] = []

  for (const [name, module] of owners) {
    const uses = manifests.flatMap((rel) => {
      const manifest = readJson(path.join(targetRoot, rel))

      return manifest === null ? [] : manifestUses(rel, manifest, name)
    })

    uses.push(...(await runnerUses(targetRoot, name, outsidePruned)))

    for (const use of uses) conflicts.push(`${use}: add "${module}" to vendorTarget.modules or stop using it`)
  }

  return conflicts.sort()
}
