import { shellLine } from 'src/lib/shell-quote'

import { sameFingerprint } from './fingerprint'
import { rebasePath, withoutExcluded } from './paths'
import type {
  ChangelogFacts,
  EntryPlan,
  SourceEntryFacts,
  SourceFacts,
  TargetEntryFacts,
  TargetFacts,
  TargetPlan,
  TargetRef,
  WriteOp,
} from './types'

/** Paths a blocked row lists before truncating; the `git status` argv shows the rest. */
const MAX_LISTED_PATHS = 20

/** Changelog lines a changed row lists before truncating. */
const MAX_CHANGELOG_LINES = 20

const SHA_DISPLAY_LENGTH = 7

const truncated = (lines: readonly string[], max: number): string[] => {
  if (lines.length <= max) return [...lines]

  return [...lines.slice(0, max), `…and ${lines.length - max} more`]
}

const uniqueSorted = (paths: Iterable<string>): string[] => {
  return [...new Set(paths)].sort()
}

/**
 * Diff one copy entry: write every source file whose bytes, mode or link text differ at its rebased target
 * path, and delete every target-tracked path the source set lacks. Excludes are applied to BOTH sides here as
 * well as at the probe, because a target-only excluded file entering the delete set would destroy a file the
 * consumer owns.
 */
export const diffEntry = (
  source: SourceEntryFacts,
  target: TargetEntryFacts,
  exclude: readonly string[],
): EntryPlan => {
  const { entry } = source
  const trackedInTarget = new Set(target.tracked)
  const targetPaths: string[] = []
  const writes: WriteOp[] = []

  for (const file of withoutExcluded(source.files, exclude)) {
    const targetPath = rebasePath(file.path, entry)

    targetPaths.push(targetPath)

    if (sameFingerprint(file.fingerprint, target.onDisk[targetPath] ?? null)) continue

    const change = trackedInTarget.has(targetPath) ? 'modified' : 'added'

    writes.push({ source: file.path, target: targetPath, mode: file.mode, change })
  }

  const sourceSet = new Set(targetPaths)
  const deletes = withoutExcluded(
    target.tracked.map((trackedPath) => {
      return { path: trackedPath }
    }),
    exclude,
  )
    .map((item) => {
      return item.path
    })
    .filter((trackedPath) => {
      return !sourceSet.has(trackedPath)
    })

  const added = writes.filter((write) => {
    return write.change === 'added'
  }).length

  return {
    ...entry,
    targetPaths,
    writes,
    deletes,
    counts: { added, modified: writes.length - added, removed: deletes.length },
  }
}

const emptyPlan = (ref: TargetRef, status: TargetPlan['status'], message: string, notes: string[] = []): TargetPlan => {
  return {
    name: ref.name,
    root: ref.root,
    status,
    message,
    notes,
    warnings: [],
    entries: [],
    legacy: [],
    writeVendorMeta: false,
    recoveryPaths: [],
  }
}

/** The pathspecs a target's preflight covers: every copy target plus every legacy path. */
export const guardedPaths = (source: SourceFacts): string[] => {
  return [
    ...source.entries.map((facts) => {
      return facts.entry.target
    }),
    ...source.legacyCleanup,
  ]
}

const blockedPlan = (source: SourceFacts, ref: TargetRef, dirty: readonly string[]): TargetPlan => {
  const statusArgv = ['git', '-C', ref.root, '--literal-pathspecs', 'status', '--', ...guardedPaths(source)]

  return emptyPlan(ref, 'fail', `blocked: ${dirty.length} uncommitted path(s) under synced paths`, [
    ...truncated(dirty, MAX_LISTED_PATHS),
    shellLine(statusArgv),
  ])
}

const changelogLines = (changelog: ChangelogFacts, sourceName: string): { notes: string[]; warnings: string[] } => {
  if (changelog.kind === 'unknown-sha') {
    return {
      notes: [],
      warnings: ['no manifest commit recorded, so the source commits since the last sync are unknown'],
    }
  }

  const sha7 = changelog.sha.slice(0, SHA_DISPLAY_LENGTH)

  if (changelog.kind === 'unresolvable') {
    return { notes: [], warnings: [`manifest commit ${sha7} is not in ${sourceName}, so the changelog is unknown`] }
  }

  const header = `${changelog.lines.length} ${sourceName} commit(s) since ${sha7}`

  return { notes: [header, ...truncated(changelog.lines, MAX_CHANGELOG_LINES)], warnings: [] }
}

const entryNote = (entry: EntryPlan): string | null => {
  const { added, modified, removed } = entry.counts

  if (added + modified + removed === 0) return null

  return `${entry.target}: ${added} added, ${modified} modified, ${removed} removed`
}

const totalsMessage = (entries: readonly EntryPlan[], legacy: readonly string[]): string => {
  const sum = (key: 'added' | 'modified' | 'removed'): number => {
    return entries.reduce((total, entry) => {
      return total + entry.counts[key]
    }, 0)
  }

  const legacyPart = legacy.length > 0 ? `, ${legacy.length} legacy removed` : ''

  return `${sum('added')} added, ${sum('modified')} modified, ${sum('removed')} removed${legacyPart}`
}

type RepoFacts = Extract<TargetFacts, { kind: 'repo' }>

const recoveryPathsFor = (entries: readonly EntryPlan[], facts: RepoFacts, writeVendorMeta: boolean): string[] => {
  const paths = entries.flatMap((entry) => {
    const modified = entry.writes
      .filter((write) => {
        return write.change === 'modified'
      })
      .map((write) => {
        return write.target
      })

    return [...modified, ...entry.deletes]
  })

  return uniqueSorted([...paths, ...facts.legacy, ...(writeVendorMeta ? facts.headVendorMeta : [])])
}

const repoPlan = (source: SourceFacts, facts: RepoFacts): TargetPlan => {
  if (facts.dirty.length > 0) return blockedPlan(source, facts, facts.dirty)

  const entries = source.entries.map((sourceEntry, index) => {
    const targetEntry = facts.entries[index] ?? { target: sourceEntry.entry.target, tracked: [], onDisk: {} }

    return diffEntry(sourceEntry, targetEntry, source.exclude)
  })
  const writeVendorMeta = entries.some((entry) => {
    return entry.vendored
  })
  const fileChanges = entries.some((entry) => {
    return entry.writes.length + entry.deletes.length > 0
  })
  const metaStale = writeVendorMeta && (!facts.readmeCurrent || !facts.manifestPresent)
  const base = { ...emptyPlan(facts, 'ok', 'up to date'), branch: facts.branch, entries, writeVendorMeta }

  if (!fileChanges && facts.legacy.length === 0 && !metaStale) return base

  const changelog = changelogLines(facts.changelog, source.name)
  const entryNotes = entries.map(entryNote).filter((note): note is string => {
    return note !== null
  })
  const legacyNotes = facts.legacy.length > 0 ? [`legacy: ${facts.legacy.length} tracked file(s) removed`] : []

  return {
    ...base,
    status: 'changed',
    message: `${totalsMessage(entries, facts.legacy)} on ${facts.branch}`,
    notes: [
      ...entryNotes,
      ...legacyNotes,
      ...(metaStale ? ['vendor/README.md and manifest rewritten'] : []),
      ...changelog.notes,
    ],
    warnings: changelog.warnings,
    legacy: facts.legacy,
    recoveryPaths: recoveryPathsFor(entries, facts, writeVendorMeta),
  }
}

/**
 * The plan row for one target, pure over probed facts so every status is testable without git.
 *
 * `ok` rows still carry `writeVendorMeta` but nothing to apply: the apply runs only on `changed` rows, because
 * a manifest rewrite alone would move `syncedAt` and dirty a target that has nothing to sync.
 */
export const buildTargetPlan = (source: SourceFacts, facts: TargetFacts): TargetPlan => {
  switch (facts.kind) {
    case 'missing':
      return emptyPlan(facts, 'skipped', `not checked out at ${facts.root}`)
    case 'source':
      return emptyPlan(facts, 'skipped', 'this is the source repo')
    case 'not-git':
      return emptyPlan(facts, 'fail', `not a git repo: ${facts.reason}`)
    case 'repo':
      return repoPlan(source, facts)
  }
}
