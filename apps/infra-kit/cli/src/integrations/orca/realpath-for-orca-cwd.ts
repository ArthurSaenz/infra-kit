import { realpath } from 'node:fs/promises'

/**
 * Resolve `path` through the filesystem, falling back to the input when it can't
 * be resolved (e.g. the directory was already removed). Both Orca-reported paths
 * and the caller's target are normalized the same way so a macOS
 * `/var`→`/private/var` symlink can't make two equal paths compare unequal.
 *
 * Selectors are NOT built from this — they take the path as `git worktree list`
 * reports it; realpath is for equality only.
 */
export const realpathForOrcaCwd = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}
