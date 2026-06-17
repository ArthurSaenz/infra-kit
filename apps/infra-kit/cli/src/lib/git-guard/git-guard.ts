import { OperationError } from 'src/lib/errors/operation-error'
import { getCurrentBranch, isInsideLinkedWorktree, isWorkingTreeClean } from 'src/lib/git-utils'

export interface AssertManagementContextArgs {
  /** Operation name surfaced in the failure message, e.g. 'create release'. */
  operation: string
  /**
   * Canonical branch the command must run from (e.g. 'dev' / 'main'). Omit to
   * skip the branch check for commands that are branch-agnostic or self-switch.
   */
  requiredBranch?: string
}

/**
 * Guard release- and worktree-management commands so they run only from the
 * main repository checkout, with a clean working tree, and (where applicable)
 * on the canonical branch.
 *
 * Checks run most-structural-first — worktree, then branch, then clean — so the
 * operator fixes the most fundamental problem first. The worktree and clean-tree
 * checks always run; the branch check runs only when `requiredBranch` is set.
 * Throws {@link OperationError} on the first violation, which surfaces uniformly
 * to both CLI users and MCP-connected agents.
 */
export const assertManagementContext = async (args: AssertManagementContextArgs): Promise<void> => {
  const { operation, requiredBranch } = args

  if (await isInsideLinkedWorktree()) {
    throw new OperationError(undefined, {
      operation,
      remediation: 'run this from the main repository checkout, not a linked git worktree',
      stderrExcerpt: 'command run from inside a linked worktree',
    })
  }

  if (requiredBranch) {
    const currentBranch = await getCurrentBranch()

    if (currentBranch !== requiredBranch) {
      throw new OperationError(undefined, {
        operation,
        remediation: `switch to ${requiredBranch} first (git switch ${requiredBranch})`,
        stderrExcerpt: `current branch is "${currentBranch}", expected "${requiredBranch}"`,
      })
    }
  }

  if (!(await isWorkingTreeClean())) {
    throw new OperationError(undefined, {
      operation,
      remediation: 'commit or stash your changes, then retry',
      stderrExcerpt: 'working tree has uncommitted changes',
    })
  }
}
