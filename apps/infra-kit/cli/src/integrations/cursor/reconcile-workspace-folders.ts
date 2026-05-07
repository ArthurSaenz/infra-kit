import fs from 'node:fs/promises'
import path from 'node:path'

import { addFoldersToCursorWorkspace } from './add-folders-to-workspace'
import { removeFoldersFromCursorWorkspace } from './remove-folders-from-workspace'

interface ReconcileCursorWorkspaceFoldersArgs {
  workspacePath: string
  worktreeDir: string
  currentBranches: string[]
}

interface ReconcileCursorWorkspaceFoldersResult {
  added: string[]
  removed: string[]
}

interface WorkspaceFolderEntry {
  path: string
  name?: string
}

interface WorkspaceFile {
  folders?: WorkspaceFolderEntry[]
  [key: string]: unknown
}

/**
 * Reconciles the configured Cursor workspace's `folders` array against the
 * actual set of release worktrees on disk:
 *   - Adds any worktree folders that aren't already listed.
 *   - Removes entries whose absolute path lives under `${worktreeDir}/release/`
 *     but no longer corresponds to a current branch (drift from manual
 *     `git worktree remove`, deleted branches, etc.).
 *
 * Non-worktree folder entries are left untouched.
 */
export const reconcileCursorWorkspaceFolders = async (
  args: ReconcileCursorWorkspaceFoldersArgs,
): Promise<ReconcileCursorWorkspaceFoldersResult> => {
  const { workspacePath, worktreeDir, currentBranches } = args

  const workspaceDir = path.dirname(workspacePath)
  const releaseRoot = path.resolve(`${worktreeDir}/release`)

  const raw = await fs.readFile(workspacePath, 'utf-8')
  const parsed = JSON.parse(raw) as WorkspaceFile

  const existingFolders = parsed.folders ?? []

  const desiredAbsolutePaths = new Set(
    currentBranches.map((branch) => {
      return path.resolve(`${worktreeDir}/${branch}`)
    }),
  )

  const danglingFolderPaths: string[] = []

  for (const entry of existingFolders) {
    const entryAbsolutePath = path.resolve(workspaceDir, entry.path)

    const isReleaseShaped = entryAbsolutePath === releaseRoot || entryAbsolutePath.startsWith(`${releaseRoot}/`)

    if (isReleaseShaped && !desiredAbsolutePaths.has(entryAbsolutePath)) {
      danglingFolderPaths.push(entryAbsolutePath)
    }
  }

  let removed: string[] = []

  if (danglingFolderPaths.length > 0) {
    const result = await removeFoldersFromCursorWorkspace({
      workspacePath,
      folderPaths: danglingFolderPaths,
    })

    removed = result.removed
  }

  const desiredFolderPaths = currentBranches.map((branch) => {
    return `${worktreeDir}/${branch}`
  })

  const { added } =
    desiredFolderPaths.length > 0
      ? await addFoldersToCursorWorkspace({ workspacePath, folderPaths: desiredFolderPaths })
      : { added: [] as string[] }

  return { added, removed }
}
