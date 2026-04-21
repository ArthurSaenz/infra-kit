import { $ } from 'zx'

interface OpenCmuxWorkspaceArgs {
  cwd: string
  title?: string
}

/**
 * Opens a new cmux workspace rooted at `cwd` with three panes:
 *   left-top (primary) | right (full-height)
 *   left-bottom        |
 * All panes inherit `cwd` from the workspace.
 */
export const openCmuxWorkspaceWithLayout = async (args: OpenCmuxWorkspaceArgs): Promise<void> => {
  const { cwd, title } = args

  const newWorkspaceOutput = (await $`cmux new-workspace --cwd ${cwd}`).stdout

  const workspaceRef = parseWorkspaceRef(newWorkspaceOutput)

  const surfacesOutput = (await $`cmux list-pane-surfaces --workspace ${workspaceRef}`).stdout

  const leftTopRef = parseFirstSurfaceRef(surfacesOutput)

  await $`cmux new-split right --workspace ${workspaceRef} --surface ${leftTopRef}`
  await $`cmux new-split down --workspace ${workspaceRef} --surface ${leftTopRef}`

  if (title) {
    await $`cmux rename-workspace --workspace ${workspaceRef} ${title}`
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
 * `cmux new-workspace`. The returned ref is used to target the newly
 * created workspace in follow-up `cmux` commands (splits, rename, etc.).
 *
 * @example
 * const output = 'created workspace:7\n'
 * parseWorkspaceRef(output) // => 'workspace:7'
 */
const parseWorkspaceRef = (output: string): string => {
  const match = output.match(/workspace:\d+/)

  if (!match) {
    throw new Error('cmux: could not locate workspace ref in new-workspace output')
  }

  return match[0]
}
