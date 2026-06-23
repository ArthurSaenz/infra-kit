import { $ } from 'zx'

import { getInfraKitConfig, resolveCmuxLayout } from 'src/lib/infra-kit-config'

interface OpenCmuxWorkspaceArgs {
  cwd: string
  title?: string
}

/**
 * Opens a new cmux workspace rooted at `cwd`, with panes arranged per the
 * configured `worktrees.cmux.layout` (resolved via {@link resolveCmuxLayout},
 * default `two-columns`):
 *   two-columns — left | right, both full-height (two panes)
 *   three-pane  — left-top / left-bottom | full-height right (three panes)
 * All panes inherit `cwd` from the workspace.
 */
export const openCmuxWorkspaceWithLayout = async (args: OpenCmuxWorkspaceArgs): Promise<void> => {
  const { cwd, title } = args

  const layout = resolveCmuxLayout(await getInfraKitConfig())

  const newWorkspaceOutput = (await $`cmux workspace create --cwd ${cwd}`).stdout

  const workspaceRef = parseWorkspaceRef(newWorkspaceOutput)

  const surfacesOutput = (await $`cmux list-pane-surfaces --workspace ${workspaceRef}`).stdout

  const leftTopRef = parseFirstSurfaceRef(surfacesOutput)

  // Both layouts share the vertical split into left | right columns; only the
  // legacy three-pane layout additionally splits the left column top/bottom.
  await $`cmux new-split right --workspace ${workspaceRef} --surface ${leftTopRef}`

  if (layout === 'three-pane') {
    await $`cmux new-split down --workspace ${workspaceRef} --surface ${leftTopRef}`
  }

  if (title) {
    await $`cmux workspace rename --workspace ${workspaceRef} --title ${title}`
  }
}

/**
 * Extracts the first `surface:<id>` reference from the output of
 * `cmux list-pane-surfaces`. Used to locate the initial (primary) pane
 * surface so subsequent splits can be anchored relative to it.
 *
 * @example
 * const output = 'surface:12 (active)\nsurface:13\n'
 * parseFirstSurfaceRef(output) // => 'surface:12'
 */
const parseFirstSurfaceRef = (output: string): string => {
  const match = output.match(/surface:\d+/)

  if (!match) {
    throw new Error('cmux: could not locate initial surface in list-pane-surfaces output')
  }

  return match[0]
}

/**
 * Extracts the `workspace:<id>` reference from the output of
 * `cmux workspace create`. The returned ref is used to target the newly
 * created workspace in follow-up `cmux` commands (splits, rename, etc.).
 *
 * @example
 * const output = 'created workspace:7\n'
 * parseWorkspaceRef(output) // => 'workspace:7'
 */
const parseWorkspaceRef = (output: string): string => {
  const match = output.match(/workspace:\d+/)

  if (!match) {
    throw new Error('cmux: could not locate workspace ref in workspace create output')
  }

  return match[0]
}
