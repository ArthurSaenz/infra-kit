import fs from 'node:fs/promises'
import path from 'node:path'

interface RemoveFoldersFromCursorWorkspaceArgs {
  workspacePath: string
  folderPaths: string[]
}

interface RemoveFoldersFromCursorWorkspaceResult {
  removed: string[]
  notFound: string[]
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
 * Removes folders from a Cursor (`.code-workspace`) file's `folders` array. Entries
 * are matched by resolved absolute path, so relative and absolute entries pointing
 * at the same folder are both removed.
 */
export const removeFoldersFromCursorWorkspace = async (
  args: RemoveFoldersFromCursorWorkspaceArgs,
): Promise<RemoveFoldersFromCursorWorkspaceResult> => {
  const { workspacePath, folderPaths } = args

  const workspaceDir = path.dirname(workspacePath)

  let raw: string

  try {
    raw = await fs.readFile(workspacePath, 'utf-8')
  } catch (error) {
    throw new Error(`Cursor workspace file not found at ${workspacePath}: ${(error as Error).message}`)
  }

  let parsed: WorkspaceFile

  try {
    parsed = JSON.parse(raw) as WorkspaceFile
  } catch (error) {
    throw new Error(
      `Failed to parse ${workspacePath} as JSON. Comments (JSONC) are not supported. ${(error as Error).message}`,
    )
  }

  const existingFolders = parsed.folders ?? []
  const targetAbsolutePaths = new Set(
    folderPaths.map((folderPath) => {
      return path.resolve(folderPath)
    }),
  )

  const removedAbsolutePaths = new Set<string>()

  const filteredFolders = existingFolders.filter((entry) => {
    const entryAbsolutePath = path.resolve(workspaceDir, entry.path)

    if (targetAbsolutePaths.has(entryAbsolutePath)) {
      removedAbsolutePaths.add(entryAbsolutePath)

      return false
    }

    return true
  })

  parsed.folders = filteredFolders

  await fs.writeFile(workspacePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8')

  const removed: string[] = []
  const notFound: string[] = []

  for (const folderPath of folderPaths) {
    const absolutePath = path.resolve(folderPath)

    if (removedAbsolutePaths.has(absolutePath)) {
      removed.push(folderPath)
    } else {
      notFound.push(folderPath)
    }
  }

  return { removed, notFound }
}
