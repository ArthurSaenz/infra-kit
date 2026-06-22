import { $ } from 'zx'

import { addFoldersToCursorWorkspace, resolveCursorWorkspacePath } from 'src/integrations/cursor'
import { addFoldersToZedWorkspace } from 'src/integrations/zed'
import { assertNever } from 'src/lib/assert-never'
import { getInfraKitConfig, resolveConfiguredIdes } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import type { AddIdeWorktreeFoldersOutcome } from './types'

interface AddIdeWorktreeFoldersArgs {
  projectRoot: string
  worktreeDir: string
  branches: string[]
}

/**
 * Workspace-mode add (used by `worktrees-add`): append the given worktree folders
 * to every configured editor's workspace and open it. Returns one outcome per
 * configured provider (empty array when no IDE is configured), iterating
 * sequentially.
 *
 * Cursor appends to the `.code-workspace` `folders` array (reporting `skipped`
 * for already-present entries) then runs `cursor <workspace>`. Zed has no
 * workspace file, so it `zed --add`s each folder (`skipped` is always 0).
 */
export const addIdeWorktreeFolders = async (
  args: AddIdeWorktreeFoldersArgs,
): Promise<AddIdeWorktreeFoldersOutcome[]> => {
  const { projectRoot, worktreeDir, branches } = args

  const config = await getInfraKitConfig()
  const ides = resolveConfiguredIdes(config)

  const folderPaths = branches.map((branch) => {
    return `${worktreeDir}/${branch}`
  })

  const outcomes: AddIdeWorktreeFoldersOutcome[] = []

  for (const ide of ides) {
    switch (ide.provider) {
      case 'cursor': {
        if (!ide.config.workspaceConfigPath) {
          logger.warn('⚠️ Skipping Cursor: ide.config.workspaceConfigPath is not set in infra-kit config')

          outcomes.push({ ran: false, provider: 'cursor', added: 0, skipped: 0 })
          break
        }

        const workspacePath = resolveCursorWorkspacePath(ide.config.workspaceConfigPath, projectRoot)

        const { added, skipped } = await addFoldersToCursorWorkspace({ workspacePath, folderPaths })

        const skippedSuffix = skipped.length > 0 ? ` (${skipped.length} already present)` : ''

        logger.info(`✅ Added ${added.length} folder(s) to ${workspacePath}${skippedSuffix}`)

        await $`cursor ${workspacePath}`

        outcomes.push({ ran: true, provider: 'cursor', added: added.length, skipped: skipped.length })
        break
      }
      case 'zed': {
        const { added } = await addFoldersToZedWorkspace({ folderPaths })

        logger.info(`✅ Added ${added.length} folder(s) to Zed workspace`)

        outcomes.push({ ran: true, provider: 'zed', added: added.length, skipped: 0 })
        break
      }
      default: {
        assertNever(ide)
      }
    }
  }

  return outcomes
}
