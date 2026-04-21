import path from 'node:path'
import { $ } from 'zx'

/**
 * Get current git worktrees
 *
 * @returns [release/v1.18.22, release/v1.18.23, release/v1.18.24] or [feature/mobile-app, feature/explore-page, feature/login-page]
 */
export const getCurrentWorktrees = async (type: 'release' | 'feature'): Promise<string[]> => {
  const worktreesOutput = await $`git worktree list`

  const worktreeLines = worktreesOutput.stdout.split('\n').filter(Boolean)

  const worktreePredicateMap = {
    release: releaseWorktreePredicate,
    feature: featureWorktreePredicate,
  }

  return worktreeLines.map(worktreePredicateMap[type]).filter((branch) => {
    return branch !== null
  })
}

/**
 * Extract a release branch name from a `git worktree list` output line.
 *
 * Returns `null` for lines that are not release worktrees.
 *
 * @example
 * releaseWorktreePredicate('/path/to/release/v1.18.22  abc1234 [release/v1.18.22]')
 * // => 'release/v1.18.22'
 *
 * @example
 * releaseWorktreePredicate('/path/to/feature/login  abc1234 [feature/login]')
 * // => null
 */
const releaseWorktreePredicate = (line: string): string | null => {
  const parts = line.split(' ').filter(Boolean)

  if (parts.length < 3 || !parts[0]?.includes('release/v')) return null

  return `release/${parts[0]?.split('/').pop() || ''}`
}

/**
 * Extract a feature branch name from a `git worktree list` output line.
 *
 * Returns `null` for lines that are not feature worktrees.
 *
 * @example
 * featureWorktreePredicate('/path/to/feature/login-page  abc1234 [feature/login-page]')
 * // => 'feature/login-page'
 *
 * @example
 * featureWorktreePredicate('/path/to/release/v1.18.22  abc1234 [release/v1.18.22]')
 * // => null
 */
const featureWorktreePredicate = (line: string): string | null => {
  const parts = line.split(' ').filter(Boolean)

  if (parts.length < 3 || !parts[0]?.includes('feature/')) return null

  return `feature/${parts[0]?.split('/').pop() || ''}`
}

/**
 * Get the current project root directory
 */
export const getProjectRoot = async (): Promise<string> => {
  const result = await $`git rev-parse --show-toplevel`

  return result.stdout.trim()
}

/**
 * Get the current repository name (basename of the project root)
 */
export const getRepoName = async (): Promise<string> => {
  const projectRoot = await getProjectRoot()

  return path.basename(projectRoot)
}
