import { DEFAULT_RELEASE_SLUG, slugifyRelease } from '@slip-stream-kit/config/internal'
import { execFileSync } from 'node:child_process'

/**
 * Slugified `<release>` for the app's git branch (resolved from the app's own dir), falling back to
 * {@link DEFAULT_RELEASE_SLUG} outside a git repo / on an empty slug. Never throws.
 *
 * A release ALWAYS resolves because it is the first DNS label of every alias, and every app is reached
 * by hostname. The fallback cannot collide the way a branch can: worktrees are what make two checkouts
 * coexist, and a worktree is by definition inside a git repo.
 */
// Shared by the dev runner, which registers `<release>.<package>.localhost`, and `e2e`, which must name
// that exact host — one derivation, or a test run probes an alias nobody registered.
export const readAppRelease = (cwd: string): string => {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8' }).trim()
    const slug = slugifyRelease(branch)

    return slug === '' ? DEFAULT_RELEASE_SLUG : slug
  } catch {
    return DEFAULT_RELEASE_SLUG
  }
}
