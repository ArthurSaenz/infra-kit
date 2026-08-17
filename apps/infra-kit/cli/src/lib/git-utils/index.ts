export {
  deleteLocalBranch,
  deleteRemoteBranch,
  getCurrentBranch,
  getCurrentWorktrees,
  getMainRepoRoot,
  getProjectRoot,
  getRepoName,
  isInsideLinkedWorktree,
  isWorkingTreeClean,
  listWorktrees,
} from './git-utils'
export type { WorktreeEntry } from './git-utils'
export { isAncestor, lsRemoteHead, pushAtomic, revParseVerify } from './merge-refs'
export type { AtomicPushRef, AtomicPushResult } from './merge-refs'
export {
  assertPristineWorktree,
  hasMergeInProgress,
  resetScratchWorktree,
  scratchWorktreePath,
  withScratchWorktree,
} from './scratch-worktree'
export type { ScratchWorktree } from './scratch-worktree'
