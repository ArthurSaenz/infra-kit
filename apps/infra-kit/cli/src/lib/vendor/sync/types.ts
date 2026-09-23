/**
 * Decoupled input shape for `vendor sync`. Deliberately NOT imported from the `infra-kit.json` schema, so the
 * sync library stays testable without the config loader and the schema can evolve on its own.
 */
export interface CopyEntry {
  path: string
  /** Defaults to `path`. */
  target?: string
}

export interface SyncSpec {
  copy: CopyEntry[]
  /** Path-segment names dropped from both sides of the diff. */
  exclude?: string[]
  /** Tracked target paths removed before copying. */
  legacyCleanup?: string[]
}

export interface ResolvedCopyEntry {
  path: string
  target: string
  /** True when the target lives under `vendor/`: only vendored entries feed the integrity manifest. */
  vendored: boolean
}

/** The three blob modes a copy can carry; gitlinks (`160000`) are never copied. */
export type GitFileMode = '100644' | '100755' | '120000'

export interface TrackedFile {
  path: string
  mode: GitFileMode
}

/** What a path holds on disk, compared instead of mtimes so an identical file is never rewritten. */
export type Fingerprint =
  { kind: 'file'; executable: boolean; sha: string } | { kind: 'link'; text: string } | { kind: 'other' }

export interface SourceFile extends TrackedFile {
  fingerprint: Fingerprint
}

export interface SourceEntryFacts {
  entry: ResolvedCopyEntry
  files: SourceFile[]
}

export interface SourceFacts {
  root: string
  /** Real paths a target must not resolve to: the source checkout and its main repo root. */
  selfRoots: string[]
  /** Basename of the source's main repo root, so a run from a linked worktree still names the repo. */
  name: string
  headSha: string
  entries: SourceEntryFacts[]
  exclude: string[]
  legacyCleanup: string[]
}

export interface TargetEntryFacts {
  target: string
  /** Target repo-relative tracked paths under the entry, excludes already dropped. */
  tracked: string[]
  /** Disk state at each rebased source path; `null` when nothing is there. */
  onDisk: Record<string, Fingerprint | null>
}

export type ChangelogFacts =
  { kind: 'unknown-sha' } | { kind: 'unresolvable'; sha: string } | { kind: 'log'; sha: string; lines: string[] }

export interface TargetRef {
  name: string
  root: string
}

export type TargetFacts =
  | (TargetRef & { kind: 'missing' })
  | (TargetRef & { kind: 'source' })
  | (TargetRef & { kind: 'not-git'; reason: string })
  | (TargetRef & {
      kind: 'repo'
      branch: string
      /** Changed tracked paths and untracked non-ignored paths under any copy or legacy path. */
      dirty: string[]
      entries: TargetEntryFacts[]
      /** Tracked files under `legacyCleanup` paths. */
      legacy: string[]
      /** `vendor/README.md` / `vendor/.sync-manifest.json` as present in HEAD, for the recovery argv. */
      headVendorMeta: string[]
      readmeCurrent: boolean
      manifestPresent: boolean
      changelog: ChangelogFacts
    })

export interface WriteOp {
  /** Source repo-relative path. */
  source: string
  /** Target repo-relative path. */
  target: string
  mode: GitFileMode
  change: 'added' | 'modified'
}

interface EntryCounts {
  added: number
  modified: number
  removed: number
}

export interface EntryPlan {
  path: string
  target: string
  vendored: boolean
  /** Every rebased source-set path, changed or not: the manifest covers all of them. */
  targetPaths: string[]
  writes: WriteOp[]
  deletes: string[]
  counts: EntryCounts
}

export type TargetPlanStatus = 'skipped' | 'fail' | 'ok' | 'changed'

export interface TargetPlan {
  name: string
  root: string
  status: TargetPlanStatus
  message: string
  notes: string[]
  /** Advisory lines the command renders as a `warn`, e.g. a manifest sha the source cannot resolve. */
  warnings: string[]
  branch?: string
  entries: EntryPlan[]
  legacy: string[]
  writeVendorMeta: boolean
  /** Tracked paths the apply will write or delete; the only input to the recovery argv. */
  recoveryPaths: string[]
}

export interface SourceIdentity {
  root: string
  name: string
  headSha: string
}

export interface ApplyResult {
  /** Every target path the apply wrote or deleted, for `--commit`. */
  touched: string[]
  manifestWritten: boolean
}
