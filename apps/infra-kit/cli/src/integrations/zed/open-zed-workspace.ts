import { $ } from 'zx'

import { logger } from 'src/lib/logger'

interface OpenZedWorkspaceArgs {
  projectRoot: string
  worktreeDir: string
  currentBranches: string[]
}

interface OpenZedWorkspaceOutcome {
  ran: boolean
  added: number
  removed: number
}

/**
 * Opens a single Zed workspace containing the project root plus every release
 * worktree, via one `zed <root> <wt...>` invocation (Zed realizes a multi-folder
 * workspace from multiple path arguments). Used by `worktrees-reload`; skips the
 * launch when there are no worktrees so it never pops a bare Zed window.
 *
 * Zed has no portable workspace file and no folder-remove CLI, so there is
 * nothing to reconcile: `added` is the number of worktrees opened and `removed`
 * is always 0. All failures are swallowed into a warning — opening Zed is
 * best-effort, mirroring the Cursor integration.
 */
export const openZedWorkspace = async (args: OpenZedWorkspaceArgs): Promise<OpenZedWorkspaceOutcome> => {
  const { projectRoot, worktreeDir, currentBranches } = args

  if (currentBranches.length === 0) {
    return { ran: false, added: 0, removed: 0 }
  }

  const paths = [
    projectRoot,
    ...currentBranches.map((branch) => {
      return `${worktreeDir}/${branch}`
    }),
  ]

  try {
    await $`zed ${paths}`

    return { ran: true, added: currentBranches.length, removed: 0 }
  } catch (error) {
    logger.warn({ error }, '⚠️ Failed to open Zed workspace')

    return { ran: false, added: 0, removed: 0 }
  }
}
