import { $ } from 'zx'

import { logger } from 'src/lib/logger'

import { canonicalizeCmuxTitle } from './canonicalize-cmux-title'

/**
 * Best-effort close of the cmux workspace whose title matches `title` (compared
 * via {@link canonicalizeCmuxTitle}, so a drifted stored title still resolves).
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
 * title matches `title`, or undefined if no match. Both sides are compared via
 * {@link canonicalizeCmuxTitle} so a workspace stored under a drifted title
 * (whitespace, or an older CLI's `v`-prefixed semver) is still found — keeping
 * close symmetric with the dedup in `worktrees-open`.
 *
 * Each line looks like:
 *   "  workspace:8  hulyo-monorepo 1.48.0"
 *   "* workspace:6  obsidian-workspace  [selected]"
 */
const findWorkspaceRefByTitle = (output: string, title: string): string | undefined => {
  const target = canonicalizeCmuxTitle(title)

  for (const rawLine of output.split('\n')) {
    // eslint-disable-next-line sonarjs/slow-regex, regexp/no-super-linear-backtracking
    const match = rawLine.match(/^[* ]\s*(workspace:\d+)\s+(.+?)(?:\s+\[selected\])?\s*$/)

    if (!match) {
      continue
    }

    const ref = match[1]
    const lineTitle = match[2]?.trim() ?? ''

    if (canonicalizeCmuxTitle(lineTitle) === target) {
      return ref
    }
  }

  return undefined
}
