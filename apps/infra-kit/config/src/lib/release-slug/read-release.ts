import { execFileSync } from 'node:child_process'

import { DEFAULT_RELEASE_SLUG, slugifyRelease } from './release-slug'

/**
 * The `<release>` label for the git branch `cwd` is on, or {@link DEFAULT_RELEASE_SLUG} outside a repo or on
 * a branch that slugifies to nothing. Never throws.
 *
 * The dev-server's alias writer, the vite helper and the Playwright helper all name the same host from it,
 * so there is one implementation: a second copy that disagreed would print a URL no alias backs.
 *
 * @example
 * readRelease('/repo-on-feature/HUL-123') // => 'hul-123'
 */
export const readRelease = (cwd: string): string => {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()

    return slugifyRelease(branch) || DEFAULT_RELEASE_SLUG
  } catch {
    return DEFAULT_RELEASE_SLUG
  }
}
