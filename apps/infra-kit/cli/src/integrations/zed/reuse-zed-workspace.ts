import { $ } from 'zx'

import { logger } from 'src/lib/logger'

interface ReuseZedWorkspaceArgs {
  projectRoot: string
  worktreeDir: string
  remainingBranches: string[]
}

interface ReuseZedWorkspaceOutcome {
  ran: boolean
}

/**
 * Reflects a worktree removal in the open Zed window by running
 * `zed --reuse <root> <remaining release worktrees...>`.
 *
 * IMPORTANT — this is destructive: `--reuse` REPLACES the focused window's
 * ENTIRE folder set with exactly these paths. The remaining set is built from
 * release worktrees only (`getCurrentWorktrees('release')`), so any other folder
 * open in that window — feature worktrees, scratch dirs, user-added dirs — is
 * DROPPED and is NOT recoverable by infra-kit (Zed offers no undo and we keep no
 * record of the prior set). The caller MUST therefore only invoke this on an
 * interactive path where a human is present and can re-add folders via
 * `zed --add`. We emit a disclosure log line saying as much.
 *
 * Distinct from `openZedWorkspace`, which runs `zed <paths>` WITHOUT `--reuse`
 * to realize a multi-folder workspace; that does not replace a focused window.
 *
 * Best-effort: any launch failure is swallowed into a warning, mirroring
 * `openZedWorkspace`. Root is always included so the path list is never empty.
 */
export const reuseZedWorkspace = async (args: ReuseZedWorkspaceArgs): Promise<ReuseZedWorkspaceOutcome> => {
  const { projectRoot, worktreeDir, remainingBranches } = args

  const paths = [
    projectRoot,
    ...remainingBranches.map((branch) => {
      return `${worktreeDir}/${branch}`
    }),
  ]

  try {
    await $`zed --reuse ${paths}`

    logger.info(
      `↻ Refreshed Zed workspace to root + ${remainingBranches.length} release worktree(s) (other folders in the focused window are not preserved)`,
    )

    return { ran: true }
  } catch (error) {
    logger.warn({ error }, '⚠️ Failed to refresh Zed workspace')

    return { ran: false }
  }
}
