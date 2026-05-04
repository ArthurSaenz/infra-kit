import fs from 'node:fs/promises'
import path from 'node:path'

interface AddFoldersToCursorWorkspaceArgs {
  workspacePath: string
  folderPaths: string[]
}

interface AddFoldersToCursorWorkspaceResult {
  added: string[]
  skipped: string[]
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
 * Adds folders to a Cursor (`.code-workspace`) file's `folders` array, skipping
 * entries that already point to the same absolute path. Folder paths are written
 * as relative to the workspace file's directory to match Cursor's default style.
 */
export const addFoldersToCursorWorkspace = async (
  args: AddFoldersToCursorWorkspaceArgs,
): Promise<AddFoldersToCursorWorkspaceResult> => {
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
  const existingAbsolutePaths = new Set(
    existingFolders.map((entry) => {
      return path.resolve(workspaceDir, entry.path)
    }),
  )

  const added: string[] = []
  const skipped: string[] = []

  for (const folderPath of folderPaths) {
    const absolutePath = path.resolve(folderPath)

    if (existingAbsolutePaths.has(absolutePath)) {
      skipped.push(folderPath)
      continue
    }

    const relativePath = path.relative(workspaceDir, absolutePath)

    existingFolders.push({ path: relativePath })
    existingAbsolutePaths.add(absolutePath)
    added.push(folderPath)
  }

  parsed.folders = existingFolders

  await fs.writeFile(workspacePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8')

  return { added, skipped }
}
