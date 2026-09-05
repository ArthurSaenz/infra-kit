import { z } from 'zod'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { removeIdeWorktreeFolders } from 'src/integrations/ide'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { isMcpMode } from 'src/lib/mcp-mode'
import { pickReleaseBranches } from 'src/lib/prompts/release-picker'
import { formatBranchName, parseReleaseRef } from 'src/lib/release-id'
import {
  detectReleaseType,
  formatBranchPickerItems,
  getJiraDescriptions,
  releaseBranchLabels,
} from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import { logRemovalResults, removeWorktrees, toRemovalToolResult } from 'src/lib/worktrees'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

// Constants
interface WorktreeManagementArgs extends RequiredConfirmedOptionArg {
  all?: boolean
  versions?: string
}

/**
 * MCP has no TTY (JSON-RPC owns stdin) and the boundary auto-confirms, so the branch picker is
 * unreachable and a bulk removal would run without any human gate. `all` is intentionally absent from
 * this tool's MCP inputSchema; guard the shared handler too so a direct/agent call can never fan out to
 * every worktree. Require MCP callers to name targets explicitly via `versions`. No-op on the CLI path.
 */
const assertMcpRemovalInput = (input: { all?: boolean; versions?: string }): void => {
  if (!isMcpMode()) return

  if (input.all) {
    throw new OperationError(undefined, {
      operation: 'remove worktrees',
      remediation: 'name targets explicitly via "versions"; bulk all=true removal is disabled over MCP',
      stderrExcerpt: 'all=true is not permitted for worktrees-remove over MCP',
    })
  }

  if (!input.versions) {
    throw new OperationError(undefined, {
      operation: 'remove worktrees',
      remediation: 'pass "versions" (comma-separated release versions/names); the interactive picker needs a TTY',
      stderrExcerpt: 'worktrees-remove over MCP requires "versions"',
    })
  }
}

/**
 * Every named target must be an active release worktree. Without this an unmatched version builds a
 * path that does not exist; `removeWorktrees` (Promise.allSettled) swallows the failure and reports a
 * no-op as success. Validate all-or-nothing BEFORE removing anything so a typo or a feature-worktree
 * name fails loudly on both the CLI `--versions` and the MCP path. The `all` and interactive-picker
 * paths select from `currentWorktrees`, so this is a no-op for them.
 */
const assertTargetsExist = (selected: string[], currentWorktrees: string[]): void => {
  const unmatched = selected.filter((branch) => {
    return !currentWorktrees.includes(branch)
  })

  if (unmatched.length > 0) {
    throw new OperationError(undefined, {
      operation: 'remove worktrees',
      remediation: `no active worktree for: ${unmatched.join(', ')}. Run 'infra-kit worktrees list' to see current worktrees`,
      stderrExcerpt: `unmatched worktree target(s): ${unmatched.join(', ')}`,
    })
  }
}

/**
 * Manage git worktrees for release branches
 * Creates worktrees for active release branches and removes unused ones
 */
export const worktreesRemove = async (options: WorktreeManagementArgs) => {
  const { confirmedCommand, all, versions } = options

  // Branch-agnostic: `git worktree remove` addresses worktrees by path and never
  // reads HEAD, so only the worktree + clean-tree legs apply.
  await assertManagementContext({ operation: 'remove worktrees' })

  // GUARD (placement is load-bearing): must stay ABOVE the `try` block below — its catch rewraps, and
  // getInfraKitConfig's missing-config throw is a PLAIN Error whose text buildMessage would drop.
  // Must stay BELOW assertManagementContext so a linked-worktree caller still gets the worktree advice.
  // Kept ABOVE assertMcpRemovalInput: "not an infra-kit project" is the more fundamental failure.
  await getInfraKitConfig()

  assertMcpRemovalInput({ all, versions })

  try {
    const currentWorktrees = await getCurrentWorktrees('release')

    if (currentWorktrees.length === 0) {
      logger.info('ℹ️ No active worktrees to remove')

      commandEcho.print()

      const empty = { removedWorktrees: [], failedWorktrees: [], count: 0 }

      return {
        content: textContent(JSON.stringify(empty, null, 2)),
        structuredContent: empty,
      }
    }

    const projectRoot = await getProjectRoot()

    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

    let selectedReleaseBranches: string[] = []

    if (all) {
      selectedReleaseBranches = currentWorktrees
    } else if (versions) {
      selectedReleaseBranches = versions.split(',').map((v) => {
        return formatBranchName(parseReleaseRef(v.trim()))
      })
    } else {
      commandEcho.setInteractive()

      const [descriptions, prInfo] = await Promise.all([getJiraDescriptions(), getReleasePRsWithInfo()])

      const releaseTypes = new Map<string, ReleaseType>(
        prInfo.map((pr) => {
          return [pr.branch, detectReleaseType(pr.title)]
        }),
      )

      selectedReleaseBranches = await pickReleaseBranches(
        formatBranchPickerItems({ branches: currentWorktrees, descriptions, types: releaseTypes }),
        { required: true },
      )
    }

    assertTargetsExist(selectedReleaseBranches, currentWorktrees)

    // Track --all flag if all branches were selected (either via flag or interactively)
    const allSelected = selectedReleaseBranches.length === currentWorktrees.length

    if (allSelected) {
      commandEcho.addOption('--all', true)
    } else {
      commandEcho.addOption('--versions', releaseBranchLabels(selectedReleaseBranches))
    }

    // Ask for confirmation
    await confirmOrExit(confirmedCommand, 'Are you sure you want to proceed with these worktree changes?')

    // Track --yes flag if confirmation was interactive (user confirmed)
    if (!confirmedCommand) {
      commandEcho.addOption('--yes', true)
    }

    const removal = await removeWorktrees({
      branches: selectedReleaseBranches,
      worktreeDir,
      projectRoot,
      pruneFolder: allSelected,
    })

    // `!confirmedCommand` is the interactive path (a human used the picker/confirm). Only there
    // do we let Zed's destructive `--reuse` relaunch fire; MCP/--yes runs (confirmedCommand=true)
    // and worktrees-sync never relaunch an editor window.
    await removeIdeWorktreeFolders({
      projectRoot,
      worktreeDir,
      currentWorktrees,
      removedWorktrees: removal.removed,
      allowEditorRelaunch: !confirmedCommand,
    })

    logRemovalResults(removal)

    commandEcho.print()

    // Ordering is load-bearing: the echo line and the IDE cleanup for the branches that DID succeed
    // run first; only then does a failed branch throw (CLI) or become an isError result (MCP).
    return toRemovalToolResult({ result: removal, operation: 'remove worktrees' })
  } catch (error) {
    // A cancelled prompt (Ctrl-C / Esc) is a user back-out, not a failure: let it
    // reach the top-level boundary untouched so it exits cleanly, instead of being
    // logged as an error with a misleading remediation.
    if (isPromptCancellation(error)) throw error

    // Our own guard failures (unmatched target, MCP misuse) already carry an actionable remediation;
    // surface them as-is instead of re-wrapping them with the generic message below.
    if (error instanceof OperationError) throw error

    logger.error({ error }, '❌ Error managing worktrees')
    throw new OperationError(error, {
      operation: 'remove worktrees',
      remediation: "check 'git worktree list' for the path; uncommitted changes block removal",
    })
  }
}

// MCP Tool Registration
export const worktreesRemoveMcpTool = defineMcpTool({
  name: 'worktrees-remove',
  description:
    'Remove local git worktrees for the named release branches. Over MCP you MUST pass "versions" (comma-separated); bulk all=true removal is disabled here (it is a one-shot, unconfirmed wipe of every worktree) — the branch picker and confirmation are unavailable without a TTY. Every named version must be an active worktree, or the call errors without removing anything. What survives: the release branches/commits themselves are never deleted, and the worktrees directory plus its release/feature subfolders are left in place (recreate a worktree with worktrees-add). What is lost: git refuses to remove a worktree with modified tracked files or untracked files, BUT it DOES delete the worktree directory including gitignored contents — a hydrated .env of Doppler secrets (re-fetch with env-load) and build output such as node_modules/dist (needs reinstall/rebuild). When every worktree is removed it also runs "git worktree prune". A branch git refuses to remove is listed in failedWorktrees and the result carries isError; a leftover that git already unregistered and that holds only tool state (.omc/state, .omc/sessions, .DS_Store) is swept automatically.',
  requiresHumanConfirm: true,
  inputSchema: {
    versions: z
      .string()
      .describe(
        'Comma-separated release versions or names to remove (e.g. "1.2.5, 1.2.6" or "checkout-redesign, 1.2.5"). Required: each must name an active worktree, or the call errors before removing anything.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe('Set true to execute; omit for a dry-run gate that echoes the resolved action.'),
  },
  outputSchema: {
    removedWorktrees: z.array(z.string()).describe('List of removed git worktree branches'),
    failedWorktrees: z
      .array(z.string())
      .describe('Branches whose worktree could NOT be removed (git refused, or an unsweepable leftover remained)'),
    count: z.number().describe('Number of git worktrees removed'),
  },
  handler: worktreesRemove,
})
