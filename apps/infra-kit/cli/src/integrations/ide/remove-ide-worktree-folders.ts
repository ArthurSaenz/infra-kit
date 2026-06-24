import { removeFoldersFromCursorWorkspace, resolveCursorWorkspacePath } from 'src/integrations/cursor'
import { reuseZedWorkspace } from 'src/integrations/zed'
import { assertNever } from 'src/lib/assert-never'
import { getInfraKitConfig, resolveConfiguredIdes } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import type { RemoveIdeWorktreeFoldersOutcome } from './types'

interface RemoveIdeWorktreeFoldersArgs {
  projectRoot: string
  worktreeDir: string
  /** All release worktrees BEFORE removal (release-only — see Zed note below). */
  currentWorktrees: string[]
  /** The subset of `currentWorktrees` that was just removed. */
  removedWorktrees: string[]
  /**
   * Whether the caller is on an interactive path where firing Zed's destructive
   * `zed --reuse` is acceptable (a human is present and confirming). Interactive
   * `worktrees-remove` passes `!confirmedCommand`; `worktrees-sync` and every
   * non-interactive/MCP run pass `false`.
   */
  allowEditorRelaunch: boolean
}

/**
 * Strip removed worktrees from every configured editor's workspace (used by
 * `worktrees-remove` and `worktrees-sync`). Returns one outcome per configured
 * provider (empty array when no IDE is configured or no worktrees were removed),
 * iterating sequentially.
 *
 * Cursor surgically edits the `.code-workspace` `folders` array — it removes
 * only the named paths and leaves everything else intact.
 *
 * Zed has no surgical remove. The only mutation mechanism, `zed --reuse`,
 * REPLACES the focused window's entire folder set, so it can only re-state the
 * release worktrees we know about and silently drops any other open folder
 * (`remaining` is built from release worktrees only). Because that is
 * destructive and unrecoverable, it fires ONLY when `allowEditorRelaunch` is
 * true (interactive `worktrees-remove`). On the non-interactive/MCP path it is a
 * deliberate no-op (`supported: true`, `removed: []`) with an info message — the
 * capability exists; skipping is a policy choice, not a missing capability.
 *
 * Zed's `removed` is ALWAYS `[]`: `--reuse` performs no diff, so it confirms no
 * specific removal and we never report intended-but-unverified paths.
 */
export const removeIdeWorktreeFolders = async (
  args: RemoveIdeWorktreeFoldersArgs,
): Promise<RemoveIdeWorktreeFoldersOutcome[]> => {
  const { projectRoot, worktreeDir, currentWorktrees, removedWorktrees, allowEditorRelaunch } = args

  if (removedWorktrees.length === 0) {
    return []
  }

  const config = await getInfraKitConfig()
  const ides = resolveConfiguredIdes(config)

  const folderPaths = removedWorktrees.map((branch) => {
    return `${worktreeDir}/${branch}`
  })

  const remainingBranches = currentWorktrees.filter((branch) => {
    return !removedWorktrees.includes(branch)
  })

  const outcomes: RemoveIdeWorktreeFoldersOutcome[] = []

  for (const ide of ides) {
    switch (ide.provider) {
      case 'cursor': {
        outcomes.push(await removeFromCursor({ ide, projectRoot, folderPaths }))
        break
      }
      case 'zed': {
        outcomes.push(await removeFromZed({ projectRoot, worktreeDir, remainingBranches, allowEditorRelaunch }))
        break
      }
      default: {
        assertNever(ide)
      }
    }
  }

  return outcomes
}

interface RemoveFromCursorArgs {
  ide: Extract<ReturnType<typeof resolveConfiguredIdes>[number], { provider: 'cursor' }>
  projectRoot: string
  folderPaths: string[]
}

/** Surgically strip the removed folder paths from the Cursor `.code-workspace`. */
const removeFromCursor = async (args: RemoveFromCursorArgs): Promise<RemoveIdeWorktreeFoldersOutcome> => {
  const { ide, projectRoot, folderPaths } = args

  if (!ide.config.workspaceConfigPath) {
    return { provider: 'cursor', supported: true, removed: [] }
  }

  const workspacePath = resolveCursorWorkspacePath(ide.config.workspaceConfigPath, projectRoot)

  try {
    const { removed } = await removeFoldersFromCursorWorkspace({ workspacePath, folderPaths })

    if (removed.length > 0) {
      logger.info(`✅ Removed ${removed.length} folder(s) from ${workspacePath}`)
    }

    return { provider: 'cursor', supported: true, removed }
  } catch (error) {
    logger.warn({ error }, `⚠️ Failed to update Cursor workspace at ${workspacePath}`)

    return { provider: 'cursor', supported: true, removed: [] }
  }
}

interface RemoveFromZedArgs {
  projectRoot: string
  worktreeDir: string
  remainingBranches: string[]
  allowEditorRelaunch: boolean
}

/**
 * Reflect the removal in Zed by relaunching the focused window onto the
 * remaining set — but ONLY on an interactive path (see the module doc for why
 * `zed --reuse` is destructive). Otherwise a deliberate no-op. `removed` is
 * always `[]` because `--reuse` performs no diff.
 */
const removeFromZed = async (args: RemoveFromZedArgs): Promise<RemoveIdeWorktreeFoldersOutcome> => {
  const { projectRoot, worktreeDir, remainingBranches, allowEditorRelaunch } = args

  if (!allowEditorRelaunch) {
    logger.info(
      'ℹ️ Zed folder removal skipped (no interactive session); close removed worktree folders in Zed manually if needed.',
    )

    return { provider: 'zed', supported: true, removed: [] }
  }

  await reuseZedWorkspace({ projectRoot, worktreeDir, remainingBranches })

  return { provider: 'zed', supported: true, removed: [] }
}
