import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'
import {
  getCurrentBranch,
  getProjectRoot,
  getWorkingTreeStatus,
  isInsideLinkedWorktree,
  listWorktrees,
} from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'

export interface AssertManagementContextArgs {
  /** Operation name surfaced in the failure message, e.g. 'create release'. */
  operation: string
}

/**
 * The preflight for a command that never touches an existing checkout: it needs a
 * repository and a resolvable `origin`, and nothing else. Deliberately narrower than
 * {@link assertManagementContext} — no linked-worktree check and no clean-tree check.
 */
// The omissions are the point rather than an oversight:
//
// - No linked-worktree check. The command does its work in a scratch worktree of its own, so where
//   it was invoked from is irrelevant.
// - No clean-tree check. It reads `refs/remotes/*` and writes only to its own scratch checkout, so
//   the operator's uncommitted work is never at stake. The old guard forced a stash before what is,
//   in effect, a remote-refs operation.
//
// Keeping this separate leaves `assertManagementContext` untouched for the commands that genuinely
// do consume the operator's checkout.
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

/** How many porcelain paths the single-line `OperationError` carries before it summarises. */
const MAX_LISTED_PATHS = 4

/**
 * Refuse an operation that would consume the operator's checkout while it holds uncommitted
 * work, naming the paths that block it.
 *
 * Split out of {@link assertManagementContext} because tree cleanliness is the *volatile*
 * half of that guard: it is the only leg that can stop being true between the check and the
 * mutation it authorizes, so it has to be re-assertable on its own immediately before each
 * destructive step.
 */
// Two channels, because one cannot carry the answer. `OperationError` renders a single line
// and caps the excerpt at 200 bytes (`operation-error.ts`), which is three or four porcelain
// entries — any tree dirtied by a build or an editor overflows it. So the full list goes to
// the log and the error carries a bounded head plus an honest count. The count is computed
// from the real total, never from the truncated slice.
export const assertCleanCheckout = async (args: AssertManagementContextArgs): Promise<void> => {
  const { operation } = args
  const status = await getWorkingTreeStatus()

  if (status.length === 0) return

  logger.error(`working tree has uncommitted changes:\n  ${status.join('\n  ')}`)

  const listed = status.slice(0, MAX_LISTED_PATHS)
  const remaining = status.length - listed.length
  const summary = remaining > 0 ? `${listed.join(', ')} (+${remaining} more)` : listed.join(', ')

  throw new OperationError(undefined, {
    operation,
    remediation: 'commit or stash your changes (`git stash -u`), then retry',
    stderrExcerpt: `working tree has uncommitted changes: ${summary}`,
  })
}

export interface AssertBaseBranchSwitchableArgs extends AssertManagementContextArgs {
  /** The branch the command is about to `git switch` onto, e.g. `dev` or `main`. */
  base: string
}

/**
 * Refuse before the command tries to `git switch` onto a base branch that another linked
 * worktree already holds — the ordinary case on a team that keeps a worktree per release.
 *
 * git's own failure already names the holding path, so this exists for the *remediation*:
 * without it the refusal surfaces through a caller that advises "verify the version or name
 * is unique and the base branch is clean", which is the wrong action entirely. Refusing here
 * also moves the failure ahead of the confirmation prompt instead of into the middle of a
 * batch that has already created releases.
 */
// The current checkout is tested by BRANCH, not by path. `listWorktrees` reports git's own
// symlink-resolved paths while `getProjectRoot` reports `--show-toplevel`, and on macOS those
// disagree (`/var` vs `/private/var`), so a path-equality predicate mis-fires. Branch identity
// is exact instead of approximate: git forbids two worktrees checking out one branch, so
// "the current branch is the base" is a complete proof that the holder is us.
export const assertBaseBranchSwitchable = async (args: AssertBaseBranchSwitchableArgs): Promise<void> => {
  const { operation, base } = args

  if ((await getCurrentBranch()) === base) return

  const holder = (await listWorktrees(await getProjectRoot())).find((entry) => {
    return entry.branch === base
  })

  if (!holder) return

  throw new OperationError(undefined, {
    operation,
    remediation: `close or remove that worktree, or run the release from it`,
    stderrExcerpt: `base branch "${base}" is checked out in the worktree at ${holder.path}`,
  })
}

/**
 * Guard release- and worktree-management commands so they run only from the main repository
 * checkout, with a clean working tree. Both refusals throw {@link OperationError}, which surfaces
 * uniformly to CLI users and MCP-connected agents.
 *
 * Deliberately says nothing about which branch you are on.
 */
// The two states checked are the ones no command can recover from on the operator's behalf: a
// linked worktree (the wrong checkout entirely) and a dirty tree (their uncommitted work is at
// stake).
//
// No branch assertion, because the commands that need a canonical branch (`release-create`,
// `gh-merge-dev`) switch onto it themselves, after their confirmation prompt and behind a
// `git fetch` — neither of which a guard running before consent could do. The rest
// (`worktrees-*`) address branches by name and never read `HEAD`. A branch assertion here would
// only refuse work that is about to succeed anyway.
export const assertManagementContext = async (args: AssertManagementContextArgs): Promise<void> => {
  const { operation } = args

  if (await isInsideLinkedWorktree()) {
    throw new OperationError(undefined, {
      operation,
      remediation: 'run this from the main repository checkout, not a linked git worktree',
      stderrExcerpt: 'command run from inside a linked worktree',
    })
  }

  await assertCleanCheckout({ operation })
}
