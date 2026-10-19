import { shellLine } from 'src/lib/shell-quote'

import { sameFingerprint } from './fingerprint'
import { shortSha } from './git'
import { rebasePath, uniqueSorted, withoutExcluded } from './paths'
import type {
  ChangelogFacts,
  EntryPlan,
  EntryScope,
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

const MAX_CHANGELOG_LINES = 20

const truncated = (lines: readonly string[], max: number): string[] => {
  if (lines.length <= max) return [...lines]

  return [...lines.slice(0, max), `…and ${lines.length - max} more`]
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
    pruned: false,
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
    writeVendorMeta: false,
    recoveryPaths: [],
  }
}

/** The pathspecs a target's preflight covers: every copy target the sync writes or deletes under. */
export const guardedPaths = (source: SourceFacts, scopes: readonly EntryScope[]): string[] => {
  return source.entries
    .filter((_facts, index) => {
      return scopes[index] !== 'release'
    })
    .map((facts) => {
      return facts.entry.target
    })
}

const blockedPlan = (
  source: SourceFacts,
  ref: TargetRef,
  scopes: readonly EntryScope[],
  dirty: readonly string[],
): TargetPlan => {
  const statusArgv = ['git', '-C', ref.root, '--literal-pathspecs', 'status', '--', ...guardedPaths(source, scopes)]

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

  const sha7 = shortSha(changelog.sha)

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

const totalsMessage = (entries: readonly EntryPlan[]): string => {
  const sum = (key: 'added' | 'modified' | 'removed'): number => {
    return entries.reduce((total, entry) => {
      return total + entry.counts[key]
    }, 0)
  }

  return `${sum('added')} added, ${sum('modified')} modified, ${sum('removed')} removed`
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

  return uniqueSorted([...paths, ...(writeVendorMeta ? facts.headVendorMeta : [])])
}

const releasedNotes = (facts: RepoFacts): string[] => {
  return facts.entries
    .filter((entry) => {
      return entry.scope === 'release' && entry.tracked.length > 0
    })
    .map((entry) => {
      return `${entry.target}: not in vendorTarget.modules, left in place for this repo to own`
    })
}

const repoPlan = (source: SourceFacts, facts: RepoFacts): TargetPlan => {
  const scopes = facts.entries.map((entry) => {
    return entry.scope
  })

  if (facts.dirty.length > 0) return blockedPlan(source, facts, scopes, facts.dirty)

  if (facts.pruneConflicts.length > 0) {
    return emptyPlan(facts, 'fail', 'blocked: a module this repo dropped is still a dependency', [
      ...truncated(facts.pruneConflicts, MAX_LISTED_PATHS),
    ])
  }

  const entries = source.entries.flatMap((sourceEntry, index) => {
    const targetEntry = facts.entries[index] ?? {
      target: sourceEntry.entry.target,
      scope: 'sync' as const,
      tracked: [],
      onDisk: {},
    }

    if (targetEntry.scope === 'release') return []

    if (targetEntry.scope === 'sync') return [diffEntry(sourceEntry, targetEntry, source.exclude)]

    // Diffed against an empty source set, so every file it tracks becomes a delete.
    return [{ ...diffEntry({ ...sourceEntry, files: [] }, targetEntry, source.exclude), pruned: true }]
  })
  const writeVendorMeta = entries.some((entry) => {
    return entry.vendored
  })
  const fileChanges = entries.some((entry) => {
    return entry.writes.length + entry.deletes.length > 0
  })
  const metaStale = writeVendorMeta && (!facts.readmeCurrent || !facts.manifestPresent)
  const base = { ...emptyPlan(facts, 'ok', 'up to date'), branch: facts.branch, entries, writeVendorMeta }

  if (!fileChanges && !metaStale) return base

  const changelog = changelogLines(facts.changelog, source.name)
  // A warn, not a block: the preview is shown before the confirm, so switching sources stays a human decision.
  const sourceSwitch =
    facts.manifestSource !== null && facts.manifestSource !== source.name
      ? [`vendor/ was last synced from ${facts.manifestSource}, not ${source.name}: this sync replaces it`]
      : []
  const entryNotes = entries.map(entryNote).filter((note): note is string => {
    return note !== null
  })
  const prunedPackages = facts.entries.some((entry) => {
    return entry.scope === 'prune' && entry.tracked.length > 0
  })
  const installHint = prunedPackages ? ['vendored modules removed: run pnpm install to update the lockfile'] : []

  return {
    ...base,
    status: 'changed',
    message: `${totalsMessage(entries)} on ${facts.branch}`,
    notes: [
      ...entryNotes,
      ...installHint,
      ...releasedNotes(facts),
      ...(metaStale ? ['vendor/README.md and manifest rewritten'] : []),
      ...changelog.notes,
    ],
    warnings: [...sourceSwitch, ...changelog.warnings],
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
    case 'bad-selection':
      return emptyPlan(facts, 'fail', `vendorTarget: ${facts.reason}`)
    case 'repo':
      return repoPlan(source, facts)
  }
}
