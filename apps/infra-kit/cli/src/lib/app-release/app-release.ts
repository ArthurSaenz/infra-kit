import { readRelease } from '@slip-stream-kit/config/internal'

/**
 * Slugified `<release>` for the app's git branch (resolved from the app's own dir), falling back to
 * `DEFAULT_RELEASE_SLUG` outside a git repo / on an empty slug. Never throws.
 *
 * A release ALWAYS resolves because it is the first DNS label of every alias, and every app is reached
 * by hostname. The fallback cannot collide the way a branch can: worktrees are what make two checkouts
 * coexist, and a worktree is by definition inside a git repo. One implementation, in the config package,
 * because the vite and Playwright helpers must name the same host.
 */
export const readAppRelease = (cwd: string): string => {
  return readRelease(cwd)
}
