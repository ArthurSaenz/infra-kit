import { $ } from 'zx'

import { logger } from 'src/lib/logger'

import { listCmuxWorkspacesByCwd, realpathForCmuxCwd } from './list-workspaces-by-cwd'

/**
 * Best-effort close of the cmux workspace rooted at `cwd`. Resolves the workspace
 * ref via {@link listCmuxWorkspacesByCwd} (which excludes group anchors, so this
 * can never close a group header) and closes it. Silently no-ops if cmux isn't
 * running, no workspace matches the cwd, or the close fails.
 *
 * Called BEFORE `git worktree remove`, so `cwd` still exists and normalizes the
 * same way as cmux's reported `current_directory`.
 */
export const closeCmuxWorkspaceByCwd = async (cwd: string): Promise<void> => {
  try {
    const byCwd = await listCmuxWorkspacesByCwd()

    const ref = byCwd.get(await realpathForCmuxCwd(cwd))

    if (!ref) {
      return
    }

    await $`cmux workspace close ${ref}`.quiet()
  } catch (error) {
    logger.debug({ error, cwd }, 'cmux: skipped closing workspace by cwd')
  }
}
