import { z } from 'zod'

import { getReleasePRs } from 'src/integrations/gh'
import { removeIdeWorktreeFolders } from 'src/integrations/ide'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { isReleaseBranch } from 'src/lib/release-id'
import { logRemovalResults, removeWorktrees, toRemovalToolResult } from 'src/lib/worktrees'
import { defineMcpTool } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

interface WorktreeSyncArgs extends RequiredConfirmedOptionArg {}

/**
 * Manage git worktrees for release branches.
 *
 * Creates worktrees for active release branches and removes unused ones
 */
export const worktreesSync = async (options: WorktreeSyncArgs) => {
  const { confirmedCommand } = options

  // Branch-agnostic: reconciles worktrees by name/path and never reads HEAD, so
  // only the worktree + clean-tree legs apply. Load-bearing on the MCP path,
  // which runs this unattended — a branch requirement there would refuse a
  // cleanup that has no quarrel with the caller's checkout.
  await assertManagementContext({ operation: 'sync worktrees' })

  // GUARD (placement is load-bearing): must stay ABOVE the `try` block below — its catch rewraps, and
  // getInfraKitConfig's missing-config throw is a PLAIN Error whose text buildMessage would drop.
  // Must stay BELOW assertManagementContext so a linked-worktree caller still gets the worktree advice.
  await getInfraKitConfig()

  try {
    const currentWorktrees = await getCurrentWorktrees('release')
    const projectRoot = await getProjectRoot()

    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

    const releasePRsList = await getReleasePRs()

    // Ask for confirmation
    await confirmOrExit(confirmedCommand, 'Are you sure you want to proceed with these worktree changes?')

    // Track --yes flag if confirmation was interactive (user confirmed)
    if (!confirmedCommand) {
      commandEcho.addOption('--yes', true)
    }

    const { branchesToRemove } = categorizeWorktrees({
      releasePRsList,
      currentWorktrees,
    })

    // Shared with worktrees-remove: same verify-then-sweep recovery for a leftover a post-exit hook
    // re-created, same {removed, failed} reporting. Branches are removed concurrently, exactly as
    // `worktrees remove --all` does.
    const removal = await removeWorktrees({
      branches: branchesToRemove,
      worktreeDir,
      projectRoot,
    })

    // Hard `false`: sync is background/stale-cleanup (predominantly the MCP path) — it must never
    // relaunch and overwrite a focused Zed window. Zed removal stays a no-op here.
    await removeIdeWorktreeFolders({
      projectRoot,
      worktreeDir,
      currentWorktrees,
      removedWorktrees: removal.removed,
      allowEditorRelaunch: false,
    })

    logRemovalResults(removal)

    commandEcho.print()

    // Ordering is load-bearing: IDE cleanup and the echo line run first; only then does a failed
    // branch throw (CLI) or become an isError result (MCP).
    return toRemovalToolResult({ result: removal, operation: 'sync worktrees' })
  } catch (error) {
    // A cancelled prompt (Ctrl-C / Esc) is a user back-out, not a failure: let it
    // reach the top-level boundary untouched so it exits cleanly, instead of being
    // logged as an error with a misleading remediation.
    if (isPromptCancellation(error)) throw error

    // A failed-removal report already names the branch and the fix; re-wrapping it with the
    // remote-connectivity remediation below would point the user at the wrong problem.
    if (error instanceof OperationError) throw error

    logger.error({ error }, '❌ Error managing worktrees')
    throw new OperationError(error, {
      operation: 'sync worktrees with remote',
      remediation: "ensure 'gh auth status' is ok and you can reach origin",
    })
  }
}

interface CategorizeWorktreesArgs {
  releasePRsList: string[]
  currentWorktrees: string[]
}

/**
 * Categorize worktrees into those that need to be created or removed
 */
const categorizeWorktrees = (args: CategorizeWorktreesArgs): { branchesToRemove: string[] } => {
  const { releasePRsList, currentWorktrees } = args

  const currentBranchNames = currentWorktrees.filter((branch) => {
    return isReleaseBranch(branch)
  })

  const branchesToRemove = currentBranchNames.filter((branch) => {
    return !releasePRsList.includes(branch)
  })

  return { branchesToRemove }
}

// MCP Tool Registration
export const worktreesSyncMcpTool = defineMcpTool({
  name: 'worktrees-sync',
  description:
    'Remove worktrees whose release PR is no longer open (stale cleanup). Only removes — never creates; use worktrees-add to create worktrees for new releases. The CLI confirmation is auto-skipped for MCP calls, so the caller is responsible for gating. A branch git refuses to remove is listed in failedWorktrees and the result carries isError; a leftover that git already unregistered and that holds only tool state (.omc/state, .omc/sessions, .DS_Store) is swept automatically.',
  inputSchema: {},
  outputSchema: {
    removedWorktrees: z.array(z.string()).describe('List of removed worktree branches'),
    failedWorktrees: z
      .array(z.string())
      .describe('Branches whose worktree could NOT be removed (git refused, or an unsweepable leftover remained)'),
    count: z.number().describe('Number of worktrees removed during sync'),
  },
  handler: worktreesSync,
})
