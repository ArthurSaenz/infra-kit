/**
 * Write-path barrel for `vendor sync`. Kept apart from `../index.ts` because this graph spawns git and
 * imports `git-utils`, while `vendor check` must stay subprocess-free so it runs in any consumer's CI.
 */
export { applyTargetPlan, manifestPathsAfterApply, recoveryArgv, writeVendorMetaOnly } from './apply'
export type { ApplyOptions } from './apply'
export { commitSyncedPaths, syncCommitMessage } from './commit'
export type { CommitResult } from './commit'
export { isVendoredTarget, resolveCopyEntries, resolveCopyEntry } from './paths'
export { buildTargetPlan, diffEntry, guardedPaths } from './plan'
export { probeSource, probeTarget } from './probe'
export { vendorReadme } from './readme'
export { listTrackedFiles, listTrackedVendorPaths } from './tracked-files'
export type {
  ApplyResult,
  CopyEntry,
  EntryPlan,
  ResolvedCopyEntry,
  SourceFacts,
  SourceIdentity,
  SyncSpec,
  TargetFacts,
  TargetPlan,
  TargetPlanStatus,
  TargetRef,
  WriteOp,
} from './types'
