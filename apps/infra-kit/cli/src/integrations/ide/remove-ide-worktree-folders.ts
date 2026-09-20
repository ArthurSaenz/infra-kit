import { removeFoldersFromCursorWorkspace, resolveCursorWorkspacePath } from 'src/integrations/cursor'
import type { ConfiguredIde } from 'src/lib/infra-kit-config'
import { getInfraKitConfig, resolveConfiguredIdes } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import type { RemoveIdeWorktreeFoldersOutcome } from './types'

interface RemoveIdeWorktreeFoldersArgs {
  projectRoot: string
  worktreeDir: string
  /** The worktrees that were just removed. */
  removedWorktrees: string[]
}

/**
 * Strip removed worktrees from every configured editor's workspace (used by
 * `worktrees-remove`, `worktrees-sync` and `release-remove`). Returns one outcome
 * per configured provider (empty array when no IDE is configured or no worktrees
 * were removed), iterating sequentially.
 *
 * Cursor surgically edits the `.code-workspace` `folders` array, so `removed` is
 * the real diff and a write failure is reported as `removed: []`, never thrown.
 */
export const removeIdeWorktreeFolders = async (
  args: RemoveIdeWorktreeFoldersArgs,
): Promise<RemoveIdeWorktreeFoldersOutcome[]> => {
  const { projectRoot, worktreeDir, removedWorktrees } = args

  if (removedWorktrees.length === 0) {
    return []
  }

  const config = await getInfraKitConfig()
  const ides = resolveConfiguredIdes(config)

  const folderPaths = removedWorktrees.map((branch) => {
    return `${worktreeDir}/${branch}`
  })

  const outcomes: RemoveIdeWorktreeFoldersOutcome[] = []

  for (const ide of ides) {
    outcomes.push(await removeFromCursor({ ide, projectRoot, folderPaths }))
  }

  return outcomes
}

interface RemoveFromCursorArgs {
  ide: ConfiguredIde
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
