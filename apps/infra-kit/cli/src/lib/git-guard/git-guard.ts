import { OperationError } from 'src/lib/errors/operation-error'
import { isInsideLinkedWorktree, isWorkingTreeClean } from 'src/lib/git-utils'

export interface AssertManagementContextArgs {
  /** Operation name surfaced in the failure message, e.g. 'create release'. */
  operation: string
}

/**
 * Guard release- and worktree-management commands so they run only from the
 * main repository checkout, with a clean working tree.
 *
 * Deliberately says nothing about which branch you are on. The commands that
 * need a canonical branch (`release-create`, `gh-merge-dev`) switch onto it
 * themselves, after their confirmation prompt and behind a `git fetch`, which a
 * guard running before consent could do neither of; the rest (`worktrees-*`)
 * address branches by name and never read `HEAD`. A branch assertion here would
 * only refuse work that is about to succeed anyway.
 *
 * What is left are the two states no command can recover from on the operator's
 * behalf: a linked worktree (wrong checkout entirely) and a dirty tree (their
 * uncommitted work is at stake). Both throw {@link OperationError}, which
 * surfaces uniformly to CLI users and MCP-connected agents.
 */
export const assertManagementContext = async (args: AssertManagementContextArgs): Promise<void> => {
  const { operation } = args

  if (await isInsideLinkedWorktree()) {
    throw new OperationError(undefined, {
      operation,
      remediation: 'run this from the main repository checkout, not a linked git worktree',
      stderrExcerpt: 'command run from inside a linked worktree',
    })
  }

  if (!(await isWorkingTreeClean())) {
    throw new OperationError(undefined, {
      operation,
      remediation: 'commit or stash your changes, then retry',
      stderrExcerpt: 'working tree has uncommitted changes',
    })
  }
}
