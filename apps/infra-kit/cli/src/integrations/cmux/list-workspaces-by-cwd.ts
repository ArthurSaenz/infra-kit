import { realpath } from 'node:fs/promises'
import { $ } from 'zx'

import { logger } from 'src/lib/logger'

interface CmuxWorkspaceListEntry {
  ref: string
  current_directory: string | null
}

interface CmuxGroupListEntry {
  anchor_workspace_ref: string | null
}

/**
 * Resolve `path` through the filesystem, falling back to the input when it can't
 * be resolved (e.g. the directory was already removed). Both the cmux-reported
 * cwd and the caller's target cwd are normalized the same way so a macOS
 * `/var`→`/private/var` style symlink can't make two equal paths compare unequal
 * (the realpath-asymmetry footgun this repo has been burned by before).
 */
const safeRealpath = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * Build a `realpath(cwd) → workspace ref` map of every currently-open cmux
 * workspace, keyed on its working directory. This is the dedup/close identity for
 * infra-kit's worktree workspaces — unique per worktree, and (unlike the title)
 * stable after the repo-name title prefix was dropped (two repos can share a
 * branch name like `fix-post-script-ci-cd`, but never a worktree path).
 *
 * Two entries are deliberately excluded:
 *   - workspaces with no `current_directory` (e.g. `infra-kit dev` panes) — they
 *     carry no worktree identity;
 *   - group ANCHOR workspaces — cmux reports the anchor's cwd as the main-repo
 *     root, so it collides with the real main-checkout workspace. Keying an
 *     anchor into the map would shadow the main workspace (breaking dedup) and,
 *     worse, let close-by-cwd close the group header. Anchors are dropped up front
 *     via `workspace-group list`'s `anchor_workspace_ref`.
 *
 * Returns an empty map if cmux isn't running or the output can't be parsed —
 * callers treat "empty" as "unknown, proceed as if nothing is open".
 */
export const listCmuxWorkspacesByCwd = async (): Promise<Map<string, string>> => {
  try {
    const [workspacesOutput, groupsOutput] = await Promise.all([
      $`cmux workspace list --json`.quiet(),
      $`cmux workspace-group list --json`.quiet(),
    ])

    const workspaces = (JSON.parse(workspacesOutput.stdout).workspaces ?? []) as CmuxWorkspaceListEntry[]
    const groups = (JSON.parse(groupsOutput.stdout).groups ?? []) as CmuxGroupListEntry[]

    const anchorRefs = new Set(
      groups
        .map((group) => {
          return group.anchor_workspace_ref
        })
        .filter((ref): ref is string => {
          return typeof ref === 'string'
        }),
    )

    const byCwd = new Map<string, string>()

    for (const workspace of workspaces) {
      if (!workspace.current_directory || anchorRefs.has(workspace.ref)) {
        continue
      }

      byCwd.set(await safeRealpath(workspace.current_directory), workspace.ref)
    }

    return byCwd
  } catch (error) {
    logger.debug({ error }, 'cmux: skipped listing workspaces by cwd')

    return new Map()
  }
}

/** Exported for callers that need the same normalization when looking up a target cwd. */
export { safeRealpath as realpathForCmuxCwd }
