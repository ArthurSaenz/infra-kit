import { $ } from 'zx'

import { logger } from 'src/lib/logger'

interface OpenZedWorkspaceArgs {
  /**
   * The exact folder set to open, as absolute paths — the caller includes the
   * repo root (Zed realizes a multi-folder workspace from multiple path
   * arguments). Path-carrying rather than reconstructing `${worktreeDir}/${branch}`
   * so detached-HEAD and out-of-convention worktrees open too.
   */
  worktreePaths: string[]
}

interface OpenZedWorkspaceOutcome {
  ran: boolean
  added: number
  removed: number
}

/**
 * Opens a single Zed workspace from the given folder paths, via one
 * `zed <path...>` invocation. Skips the launch when the set is empty so it never
 * pops a bare Zed window.
 *
 * Zed has no portable workspace file and no folder-remove CLI, so there is
 * nothing to reconcile: `added` is the number of folders opened and `removed`
 * is always 0. All failures are swallowed into a warning — opening Zed is
 * best-effort, mirroring the Cursor integration.
 */
export const openZedWorkspace = async (args: OpenZedWorkspaceArgs): Promise<OpenZedWorkspaceOutcome> => {
  const { worktreePaths } = args

  if (worktreePaths.length === 0) {
    return { ran: false, added: 0, removed: 0 }
  }

  try {
    await $`zed ${worktreePaths}`

    return { ran: true, added: worktreePaths.length, removed: 0 }
  } catch (error) {
    logger.warn({ error }, '⚠️ Failed to open Zed workspace')

    return { ran: false, added: 0, removed: 0 }
  }
}
