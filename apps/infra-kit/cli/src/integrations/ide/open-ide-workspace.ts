import { openCursorWorkspace } from 'src/integrations/cursor'
import { openZedWorkspace } from 'src/integrations/zed'
import { assertNever } from 'src/lib/assert-never'
import { getInfraKitConfig, resolveConfiguredIdes } from 'src/lib/infra-kit-config'

import type { OpenIdeWorkspaceOutcome } from './types'

interface OpenIdeWorkspaceArgs {
  projectRoot: string
  worktreeDir: string
  /**
   * The exact absolute folder set to open (root-first). Consumed by Zed, which
   * launches paths directly — this is what lets detached-HEAD and
   * out-of-convention worktrees open.
   */
  worktreePaths: string[]
  /**
   * Release branches, for Cursor's `.code-workspace` reconcile (its folder model
   * is release-branch-shaped, so it stays branch-based rather than path-carrying).
   */
  currentBranches: string[]
}

/**
 * Provider-agnostic entry point for the reload open: for every configured
 * editor, reconciles (or, for Zed, simply assembles) the workspace against the
 * release worktrees on disk and launches it — skipping the launch when there are
 * no worktrees, so `reopen` never pops a bare editor window. Returns
 * one outcome per configured provider (empty array when no IDE is configured).
 * Iterates sequentially — `reopen` already wraps this call in an outer
 * `Promise.all` with cmux, so a `Promise.all` here would compound editor-spawn
 * concurrency. Best-effort — every provider swallows failures into a warning.
 */
export const openIdeWorkspace = async (args: OpenIdeWorkspaceArgs): Promise<OpenIdeWorkspaceOutcome[]> => {
  const config = await getInfraKitConfig()
  const ides = resolveConfiguredIdes(config)

  const { projectRoot, worktreeDir, worktreePaths, currentBranches } = args

  const outcomes: OpenIdeWorkspaceOutcome[] = []

  for (const ide of ides) {
    switch (ide.provider) {
      case 'cursor': {
        // Cursor reconciles a release-branch-shaped `.code-workspace` file, so it
        // stays branch-based rather than consuming the harvested paths.
        const outcome = await openCursorWorkspace({
          projectRoot,
          worktreeDir,
          currentBranches,
          cursorConfig: ide.config,
        })

        outcomes.push({ ...outcome, provider: 'cursor' })
        break
      }
      case 'zed': {
        const outcome = await openZedWorkspace({ worktreePaths })

        outcomes.push({ ...outcome, provider: 'zed' })
        break
      }
      default: {
        assertNever(ide)
      }
    }
  }

  return outcomes
}
