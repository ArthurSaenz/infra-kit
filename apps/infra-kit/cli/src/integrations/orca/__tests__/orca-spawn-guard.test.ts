import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Structural fences from docs/orca-migration-plan.md §1: one spawn site, no
 * `orca worktree` mutation verbs, and named teardown callers only. Every fence scans all of
 * `src/`, so a new file is covered the moment it exists; the teardown fence alone allowlists
 * its callers, because closing a worktree's terminals is a deliberate per-command decision.
 */
const SRC = resolve(import.meta.dirname, '../../..')
const SPAWN_SITE = 'integrations/orca/run-orca.ts'
const LEGACY_DIR = 'integrations/cmux'
// `release rename` closes a worktree's terminals before `git worktree move` (.omc/plans/release-rename.md §2 Orca).
const TEARDOWN_CALLERS = ['lib/worktrees/remove-worktrees.ts', 'commands/release-rename/rename-steps.ts']
const TEARDOWN_HOME = 'integrations/orca'

// Two template forms: a bare `` $`orca `` tag and a configured `` $({ … })`orca `` tag — the driver's own
// form, which the bare marker never matches (a fence with only the bare marker fences nothing). A plain
// `` `orca `` would also match prose in comments, so the configured form is anchored on its `)`.
const SPAWN_MARKERS = ['$`orca ', ')`orca ', "spawn('orca'", "checkCommand(['orca'"]
const MUTATION_VERBS = ['worktree rm', 'worktree create']
const MUTATION_SCOPES = ['integrations/orca', 'commands', 'lib/worktrees', 'dev']

const sourceFiles = (): string[] => {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((path) => {
      return path.endsWith('.ts') && !path.split(sep).includes('__tests__')
    })
    .map((path) => {
      return path.split(sep).join('/')
    })
    .filter((path) => {
      return !path.startsWith(`${LEGACY_DIR}/`)
    })
    .sort()
}

const filesContaining = (needle: string, files: string[]): string[] => {
  return files.filter((path) => {
    return readFileSync(join(SRC, path), 'utf8').includes(needle)
  })
}

const files = sourceFiles()

describe('orca driver fences', () => {
  it('sweeps a non-trivial tree', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(files).toContain(SPAWN_SITE)
  })

  it.each(SPAWN_MARKERS)('%s appears only in run-orca.ts', (marker) => {
    expect(
      filesContaining(marker, files).filter((path) => {
        return path !== SPAWN_SITE
      }),
    ).toEqual([])
  })

  // Positive control: a marker that matches nothing would make the sweep above vacuous.
  it('the template marker sees the real spawn site', () => {
    expect(filesContaining(')`orca ', files)).toEqual([SPAWN_SITE])
  })

  it.each(MUTATION_VERBS)('`%s` appears nowhere in the driver or its callers', (verb) => {
    const scoped = files.filter((path) => {
      return MUTATION_SCOPES.some((scope) => {
        return path.startsWith(`${scope}/`)
      })
    })

    expect(filesContaining(verb, scoped)).toEqual([])
  })

  it('closeOrcaWorktreeTerminals is referenced only by the teardown callers outside the driver', () => {
    const importers = filesContaining('closeOrcaWorktreeTerminals', files).filter((path) => {
      return !path.startsWith(`${TEARDOWN_HOME}/`) && !TEARDOWN_CALLERS.includes(path)
    })

    expect(importers).toEqual([])
    expect(filesContaining('closeOrcaWorktreeTerminals', TEARDOWN_CALLERS)).toEqual(TEARDOWN_CALLERS)
  })
})
