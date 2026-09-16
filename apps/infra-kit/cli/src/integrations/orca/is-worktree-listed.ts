import { realpathForOrcaCwd } from './realpath-for-orca-cwd'
import { runOrca } from './run-orca'

interface OrcaWorktreeListResult {
  worktrees?: Array<{ path: string }>
}

const WORKTREE_LIST_LIMIT = '500'

/**
 * Whether the sidebar shows the worktree at `cwd`. Distinct from "the selector
 * resolves it": a hidden external worktree still answers `terminal create` with a
 * tab nobody can see (docs/orca-cli-findings.md, gate outcome), so callers use
 * this to report `orcaHidden` instead of a silent success.
 */
export const isOrcaWorktreeListed = async (mainRepoRoot: string, cwd: string): Promise<boolean> => {
  const [{ worktrees = [] }, wanted] = await Promise.all([
    runOrca<OrcaWorktreeListResult>([
      'worktree',
      'list',
      '--repo',
      `path:${mainRepoRoot}`,
      '--limit',
      WORKTREE_LIST_LIMIT,
    ]),
    realpathForOrcaCwd(cwd),
  ])

  for (const worktree of worktrees) {
    if ((await realpathForOrcaCwd(worktree.path)) === wanted) {
      return true
    }
  }

  return false
}
