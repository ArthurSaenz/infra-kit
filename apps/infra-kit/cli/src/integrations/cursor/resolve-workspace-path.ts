import path from 'node:path'

/**
 * Resolves the configured Cursor workspace path against the project root.
 * Absolute paths are returned unchanged.
 */
export const resolveCursorWorkspacePath = (configValue: string, projectRoot: string): string => {
  if (path.isAbsolute(configValue)) {
    return configValue
  }

  return path.resolve(projectRoot, configValue)
}
