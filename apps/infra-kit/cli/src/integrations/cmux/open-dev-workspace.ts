import process from 'node:process'
import { $ } from 'zx'

import type { CmuxLayoutNode } from 'src/dev/cmux-layout'
import { logger } from 'src/lib/logger'

/** Args for {@link openCmuxDevWorkspace}: the workspace root, title, and pane layout tree. */
interface OpenCmuxDevWorkspaceArgs {
  cwd: string
  title: string
  layout: CmuxLayoutNode
}

/**
 * True iff the `cmux` CLI is invokable (i.e. `cmux --version` resolves). Used to
 * gate `--cmux` mode and fall back to single-process dev when cmux is absent.
 */
export const isCmuxAvailable = async (): Promise<boolean> => {
  try {
    await $`cmux --version`.quiet()

    return true
  } catch {
    return false
  }
}

/**
 * Open ONE cmux workspace rooted at `cwd`, laid out per `layout` (one pane per
 * command). Runs in a `CMUX_QUIET=1` scoped env to suppress cmux's one-time compat
 * notice, then parses and returns the `workspace:<id>` ref from stdout.
 */
export const openCmuxDevWorkspace = async (args: OpenCmuxDevWorkspaceArgs): Promise<string> => {
  const { cwd, title, layout } = args
  const layoutJson = JSON.stringify(layout)

  const $cmux = $({ env: { ...process.env, CMUX_QUIET: '1' } })
  const output = (await $cmux`cmux new-workspace --name ${title} --cwd ${cwd} --focus false --layout ${layoutJson}`)
    .stdout

  return parseWorkspaceRef(output)
}

/**
 * Best-effort close of the cmux workspace `ref`, tearing down the workspace and
 * every pane process. Silently no-ops (debug-logged) if cmux isn't running or the
 * close fails, mirroring {@link file://./close-workspace-by-title.ts}.
 */
export const closeCmuxDevWorkspace = async (ref: string): Promise<void> => {
  try {
    await $`cmux close-workspace --workspace ${ref}`.quiet()
  } catch (error) {
    logger.debug({ error, ref }, 'cmux: skipped closing dev workspace')
  }
}

/**
 * Extract the `workspace:<id>` ref from `cmux new-workspace` output (e.g.
 * `OK workspace:5`). Throws a clear error when no ref is present.
 *
 * @example
 * parseWorkspaceRef('OK workspace:5\n') // => 'workspace:5'
 */
const parseWorkspaceRef = (output: string): string => {
  const match = output.match(/workspace:\d+/)

  if (!match) {
    throw new Error('cmux: could not locate workspace ref in new-workspace output')
  }

  return match[0]
}
