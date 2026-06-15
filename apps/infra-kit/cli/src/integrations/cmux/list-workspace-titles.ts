import { $ } from 'zx'

import { logger } from 'src/lib/logger'

import { canonicalizeCmuxTitle } from './canonicalize-cmux-title'

/**
 * Returns the set of **canonical** titles for all currently-open cmux
 * workspaces (see {@link canonicalizeCmuxTitle}). Keying on the canonical form
 * lets callers match a workspace even when its stored title drifted from the
 * title they rebuild (whitespace, or an older CLI's `v`-prefixed semver).
 * Returns an empty set if cmux isn't running, the call fails, or the output
 * can't be parsed — callers should treat "empty" as "unknown, proceed as if
 * nothing is open".
 *
 * Each line of `cmux list-workspaces` looks like:
 *   "  workspace:8  hulyo-monorepo 1.48.0"
 *   "* workspace:6  obsidian-workspace  [selected]"
 */
export const listCmuxWorkspaceTitles = async (): Promise<Set<string>> => {
  try {
    const output = (await $`cmux list-workspaces`.quiet()).stdout

    const titles = new Set<string>()

    for (const rawLine of output.split('\n')) {
      // eslint-disable-next-line sonarjs/slow-regex, regexp/no-super-linear-backtracking
      const match = rawLine.match(/^[* ]\s*workspace:\d+\s+(.+?)(?:\s+\[selected\])?\s*$/)

      if (!match) {
        continue
      }

      const title = match[1]?.trim()

      if (title) {
        titles.add(canonicalizeCmuxTitle(title))
      }
    }

    return titles
  } catch (error) {
    logger.debug({ error }, 'cmux: skipped listing workspace titles')

    return new Set()
  }
}
