import { removeFoldersFromCursorWorkspace, resolveCursorWorkspacePath } from 'src/integrations/cursor'
import { assertNever } from 'src/lib/assert-never'
import { getInfraKitConfig, resolveConfiguredIdes } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import type { RemoveIdeWorktreeFoldersOutcome } from './types'

interface RemoveIdeWorktreeFoldersArgs {
  projectRoot: string
  worktreeDir: string
  branches: string[]
}

/**
 * Strip removed worktrees from every configured editor's workspace (used by
 * `worktrees-remove` and `worktrees-sync`). Returns one outcome per configured
 * provider (empty array when no IDE is configured or no worktrees were removed),
 * iterating sequentially.
 *
 * Cursor edits the `.code-workspace` `folders` array. Zed has no folder-remove
 * CLI, so it is a structural no-op (`supported: false`) with an info-level
 * message — never a warning, because nothing failed.
 */
export const removeIdeWorktreeFolders = async (
  args: RemoveIdeWorktreeFoldersArgs,
): Promise<RemoveIdeWorktreeFoldersOutcome[]> => {
  const { projectRoot, worktreeDir, branches } = args

  if (branches.length === 0) {
    return []
  }

  const config = await getInfraKitConfig()
  const ides = resolveConfiguredIdes(config)

  const folderPaths = branches.map((branch) => {
    return `${worktreeDir}/${branch}`
  })

  const outcomes: RemoveIdeWorktreeFoldersOutcome[] = []

  for (const ide of ides) {
    switch (ide.provider) {
      case 'cursor': {
        if (!ide.config.workspaceConfigPath) {
          outcomes.push({ provider: 'cursor', supported: true, removed: [] })
          break
        }

        const workspacePath = resolveCursorWorkspacePath(ide.config.workspaceConfigPath, projectRoot)

        try {
          const { removed } = await removeFoldersFromCursorWorkspace({ workspacePath, folderPaths })

          if (removed.length > 0) {
            logger.info(`✅ Removed ${removed.length} folder(s) from ${workspacePath}`)
          }

          outcomes.push({ provider: 'cursor', supported: true, removed })
        } catch (error) {
          logger.warn({ error }, `⚠️ Failed to update Cursor workspace at ${workspacePath}`)

          outcomes.push({ provider: 'cursor', supported: true, removed: [] })
        }
        break
      }
      case 'zed': {
        logger.info('ℹ️ Zed has no folder-remove CLI; close removed worktree folders in Zed manually if needed.')

        outcomes.push({ provider: 'zed', supported: false, removed: [] })
        break
      }
      default: {
        assertNever(ide)
      }
    }
  }

  return outcomes
}
