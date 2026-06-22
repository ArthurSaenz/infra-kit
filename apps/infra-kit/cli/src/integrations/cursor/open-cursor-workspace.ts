import { $ } from 'zx'

import { logger } from 'src/lib/logger'

import { reconcileCursorWorkspaceFolders } from './reconcile-workspace-folders'
import { resolveCursorWorkspacePath } from './resolve-workspace-path'

interface OpenCursorWorkspaceArgs {
  projectRoot: string
  worktreeDir: string
  currentBranches: string[]
  /**
   * When true, skip the `cursor <workspace>` relaunch if there are no release
   * worktrees (folder reconcile still runs to strip dangling entries). Lets
   * `worktrees-reload` avoid popping an empty Cursor window while keeping the
   * cold-start `worktrees-open` behaviour (relaunch unconditionally) intact.
   */
  skipRelaunchWhenEmpty: boolean
  /**
   * The Cursor entry's config, selected by the facade from the (possibly
   * multi-IDE) infra-kit config. Passed in rather than re-read here so this
   * opener acts on the exact entry the caller chose — essential once `ide` can
   * be an array of providers.
   */
  cursorConfig: { workspaceConfigPath: string }
}

interface OpenCursorWorkspaceOutcome {
  ran: boolean
  added: number
  removed: number
}

/**
 * Reconciles the configured Cursor `.code-workspace` `folders` array against the
 * set of release worktrees on disk, then launches Cursor against it. Shared by
 * `worktrees-open` (cold-start restore) and `worktrees-reload` (close + reopen).
 *
 * No-ops (returns `ran: false`) when the Cursor entry has no `workspaceConfigPath`.
 * All failures are swallowed into a warning — opening Cursor is best-effort.
 */
export const openCursorWorkspace = async (args: OpenCursorWorkspaceArgs): Promise<OpenCursorWorkspaceOutcome> => {
  const { projectRoot, worktreeDir, currentBranches, skipRelaunchWhenEmpty, cursorConfig } = args

  if (!cursorConfig.workspaceConfigPath) {
    logger.warn('⚠️ Skipping Cursor: workspaceConfigPath is not set.')

    return { ran: false, added: 0, removed: 0 }
  }

  const workspacePath = resolveCursorWorkspacePath(cursorConfig.workspaceConfigPath, projectRoot)

  try {
    const { added, removed } = await reconcileCursorWorkspaceFolders({
      workspacePath,
      worktreeDir,
      currentBranches,
    })

    if (!(skipRelaunchWhenEmpty && currentBranches.length === 0)) {
      await $`cursor ${workspacePath}`
    }

    return { ran: true, added: added.length, removed: removed.length }
  } catch (error) {
    logger.warn({ error }, `⚠️ Failed to reconcile/open Cursor workspace at ${workspacePath}`)

    return { ran: false, added: 0, removed: 0 }
  }
}
