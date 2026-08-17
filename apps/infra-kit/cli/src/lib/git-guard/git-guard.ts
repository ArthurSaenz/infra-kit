import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'
import { isInsideLinkedWorktree, isWorkingTreeClean } from 'src/lib/git-utils'

export interface AssertManagementContextArgs {
  /** Operation name surfaced in the failure message, e.g. 'create release'. */
  operation: string
}

/**
 * The preflight for a command that never touches an existing checkout: it needs a
 * repository and a resolvable `origin`, and nothing else.
 *
 * Deliberately narrower than {@link assertManagementContext}, and the omissions
 * are the point rather than an oversight:
 *
 * - **No linked-worktree check.** The command does its work in a scratch worktree
 *   of its own, so where it was invoked from is irrelevant.
 * - **No clean-tree check.** It reads `refs/remotes/*` and writes only to its own
 *   scratch checkout, so the operator's uncommitted work is never at stake. The
 *   old guard forced a stash before what is, in effect, a remote-refs operation.
 *
 * Keeping this separate leaves `assertManagementContext` untouched for the
 * commands that genuinely do consume the operator's checkout.
 */
export const assertRepoWithOrigin = async (args: AssertManagementContextArgs): Promise<void> => {
  const { operation } = args

  try {
    await $({ quiet: true })`git rev-parse --git-dir`
  } catch (error) {
    throw new OperationError(error, {
      operation,
      remediation: 'run this from inside a git repository',
    })
  }

  try {
    await $({ quiet: true })`git remote get-url origin`
  } catch (error) {
    throw new OperationError(error, {
      operation,
      remediation: 'this repository has no `origin` remote to fetch from or push to',
    })
  }
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
