/**
 * Write-path barrel for `vendor sync`. Kept apart from `../index.ts` because this graph spawns git and
 * imports `git-utils`, while `vendor check` must stay subprocess-free so it runs in any consumer's CI.
 */
export { applyTargetPlan, manifestPathsAfterApply, recoveryArgv, writeVendorMetaOnly } from './apply'
export { commitSyncedPaths, syncCommitMessage } from './commit'
export type { CommitResult } from './commit'
export { runGit } from './git'
export { isVendoredTarget, resolveCopyEntry } from './paths'
export { buildTargetPlan, diffEntry } from './plan'
export { parsePorcelainZ, probeSource, probeTarget } from './probe'
export type { ApplyResult, SourceFacts, SyncSpec, TargetFacts, TargetPlan, TargetRef } from './types'
