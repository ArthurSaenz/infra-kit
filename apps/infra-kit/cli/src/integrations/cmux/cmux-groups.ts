import { $ } from 'zx'

import { logger } from 'src/lib/logger'

interface CmuxGroupListEntry {
  ref: string
  name: string
}

/**
 * Return the `workspace_group:N` ref of the sidebar group titled exactly `name`,
 * or `null` if no such group exists (or cmux is unreachable). Group names are the
 * repo name (basename of the main-repo root), so worktree workspaces for one repo
 * all resolve to the same group regardless of which worktree the command runs in.
 */
export const findCmuxGroupRefByName = async (name: string): Promise<string | null> => {
  try {
    const output = (await $`cmux workspace-group list --json`.quiet()).stdout

    const groups = (JSON.parse(output).groups ?? []) as CmuxGroupListEntry[]

    const match = groups.find((group) => {
      return group.name === name
    })

    return match?.ref ?? null
  } catch (error) {
    logger.debug({ error, name }, 'cmux: skipped group lookup')

    return null
  }
}

/**
 * Create a pinned sidebar group named `name` seeded with EXACTLY `fromRefs`, and
 * return its ref (or `null` on failure).
 *
 * `--from` is load-bearing: `cmux workspace-group create` defaults `--from` to the
 * currently-selected/caller workspace, so omitting it silently captures an
 * unrelated workspace (and, under the `--all` fan-out, steals a sibling repo's
 * freshly-created workspace). Passing the seed refs explicitly makes creation
 * deterministic and capture-free — no snapshot/self-heal needed. The group also
 * gets a synthetic anchor workspace (its header row), matching how the user's
 * groups are already shaped.
 */
export const createCmuxGroupFrom = async (name: string, fromRefs: string[]): Promise<string | null> => {
  try {
    const output = (await $`cmux workspace-group create --name ${name} --from ${fromRefs.join(',')}`).stdout

    const ref = output.match(/workspace_group:\d+/)?.[0] ?? (await findCmuxGroupRefByName(name))

    if (ref) {
      await $`cmux workspace-group pin ${ref}`.quiet()
    }

    return ref ?? null
  } catch (error) {
    logger.warn({ error, name }, '⚠️ cmux: failed to create workspace group')

    return null
  }
}
