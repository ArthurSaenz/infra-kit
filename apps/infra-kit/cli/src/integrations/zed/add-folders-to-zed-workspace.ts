import { $ } from 'zx'

interface AddFoldersToZedWorkspaceArgs {
  folderPaths: string[]
}

interface AddFoldersToZedWorkspaceResult {
  added: string[]
}

/**
 * Adds folders to Zed's current workspace via `zed --add <path>` per folder.
 * This is the only legitimate use of `--add` (it targets the most-recent
 * workspace, so it is reserved for the incremental add-only path right after
 * `worktrees-add` creates new worktrees — never for the full cold-start open).
 *
 * Zed has no folder-remove CLI and no skip-if-present concept, so every folder
 * is reported as added (no `skipped` set, unlike the Cursor `.code-workspace`).
 */
export const addFoldersToZedWorkspace = async (
  args: AddFoldersToZedWorkspaceArgs,
): Promise<AddFoldersToZedWorkspaceResult> => {
  const { folderPaths } = args

  for (const folderPath of folderPaths) {
    await $`zed --add ${folderPath}`
  }

  return { added: folderPaths }
}
