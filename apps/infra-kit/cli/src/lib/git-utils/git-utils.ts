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

const releaseWorktreePredicate = (line: string): string | null => {
  const parts = line.split(' ').filter(Boolean)

  if (parts.length < 3 || !parts[0]?.includes('release/v')) return null

  return `release/${parts[0]?.split('/').pop() || ''}`
}

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
