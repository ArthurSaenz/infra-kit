import { $ } from 'zx'

import { logger } from 'src/lib/logger'

/**
 * Best-effort close of the cmux workspace whose title exactly matches `title`.
 * Silently no-ops if cmux isn't running, the workspace isn't found, or close fails.
 */
export const closeCmuxWorkspaceByTitle = async (title: string): Promise<void> => {
  try {
    const listOutput = (await $`cmux list-workspaces`.quiet()).stdout

    const ref = findWorkspaceRefByTitle(listOutput, title)

    if (!ref) {
      return
    }

    await $`cmux close-workspace --workspace ${ref}`.quiet()
  } catch (error) {
    logger.debug({ error, title }, 'cmux: skipped closing workspace')
  }
}

/**
 * Parses `cmux list-workspaces` output and returns the workspace ref whose
 * title exactly matches `title`, or undefined if no match.
 *
 * Each line looks like:
 *   "  workspace:8  hulyo-monorepo v1.48.0"
 *   "* workspace:6  obsidian-workspace  [selected]"
 */
const findWorkspaceRefByTitle = (output: string, title: string): string | undefined => {
  for (const rawLine of output.split('\n')) {
    // eslint-disable-next-line sonarjs/slow-regex, regexp/no-super-linear-backtracking
    const match = rawLine.match(/^[* ]\s*(workspace:\d+)\s+(.+?)(?:\s+\[selected\])?\s*$/)

    if (!match) {
      continue
    }

    const ref = match[1]
    const lineTitle = match[2]?.trim() ?? ''

    if (lineTitle === title) {
      return ref
    }
  }

  return undefined
}
