import path from 'node:path'
import { $ } from 'zx'

import { isReleaseBranch } from 'src/lib/release-id'

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
 * Extract the branch name from a `git worktree list` output line.
 *
 * `git worktree list` formats each line as:
 *   <path>  <hash> [<branch>]
 *
 * Reads the branch from the trailing `[branch]` token so it works for the
 * main checkout too (whose path does not encode the branch name).
 */
const parseWorktreeBranch = (line: string): string | null => {
  const trimmed = line.trimEnd()

  if (!trimmed.endsWith(']')) return null

  const open = trimmed.lastIndexOf('[')

  if (open === -1) return null

  const branch = trimmed.slice(open + 1, -1)

  return branch.length > 0 ? branch : null
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
  const branch = parseWorktreeBranch(line)

  return isReleaseBranch(branch) ? branch : null
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
  const branch = parseWorktreeBranch(line)

  return branch?.startsWith('feature/') ? branch : null
}

/**
 * Get the current project root directory
 */
export const getProjectRoot = async (): Promise<string> => {
  const result = await $`git rev-parse --show-toplevel`

  return result.stdout.trim()
}

/**
 * Absolute path to the MAIN repository root — invariant across the main checkout
 * and all of its linked worktrees. A linked worktree's `--show-toplevel` is the
 * worktree's own path, but its `--git-common-dir` still points at the shared
 * `<main>/.git`, so the parent of the resolved common dir is always the main repo.
 * This is the stable identity to key per-repo state on (unlike `getProjectRoot`,
 * whose basename is the worktree's leaf directory inside a worktree).
 *
 * Submodules are the one exception: their common dir is
 * `<super>/.git/modules/<name>`, whose parent (`.../.git/modules`) is not a repo
 * root — there is no meaningful "main repo" to converge on — so we fall back to
 * the caller-supplied toplevel unchanged. Callers must pass a git toplevel as
 * `cwd` (e.g. the result of {@link getProjectRoot}); the fallback assumes it.
 *
 * @example
 * // main checkout: common dir '.git' → resolve → '<main>/.git' → dirname → '<main>'
 * await getMainRepoRoot('/Users/me/projects/hulyo')            // => '/Users/me/projects/hulyo'
 * // linked worktree: common dir '<main>/.git' → dirname → '<main>'
 * await getMainRepoRoot('/Users/me/projects/hulyo-worktrees/feature/x') // => '/Users/me/projects/hulyo'
 */
export const getMainRepoRoot = async (cwd?: string): Promise<string> => {
  const root = cwd ?? (await getProjectRoot())
  const commonDir = (await $({ cwd: root })`git rev-parse --git-common-dir`).stdout.trim()
  const resolved = path.resolve(root, commonDir)

  // Submodule: common dir sits under `<super>/.git/modules/<name>` — no stable
  // main-repo root to key on, so keep the caller's own toplevel.
  if (resolved.includes(`${path.sep}.git${path.sep}modules${path.sep}`)) return root

  return path.dirname(resolved)
}

/**
 * Get the current git branch name (e.g. `dev`, `main`, `release/v1.2.3`).
 */
export const getCurrentBranch = async (): Promise<string> => {
  const result = await $`git rev-parse --abbrev-ref HEAD`

  return result.stdout.trim()
}

/**
 * Whether the working tree has no staged, unstaged, or untracked changes.
 */
export const isWorkingTreeClean = async (): Promise<boolean> => {
  const result = await $`git status --porcelain`

  return result.stdout.trim().length === 0
}

/**
 * Whether the current checkout is a linked git worktree rather than the main
 * repository checkout.
 *
 * A linked worktree's git dir lives under `<main>/.git/worktrees/<name>`, so it
 * differs from the shared common dir; in the main checkout the two resolve to
 * the same path. Both are anchored to the toplevel so `--git-common-dir` (which
 * git may report relative to cwd) resolves consistently.
 */
export const isInsideLinkedWorktree = async (): Promise<boolean> => {
  const cwd = await getProjectRoot()

  const [gitDirResult, commonDirResult] = await Promise.all([
    $({ cwd })`git rev-parse --absolute-git-dir`,
    $({ cwd })`git rev-parse --git-common-dir`,
  ])

  const gitDir = gitDirResult.stdout.trim()
  const commonDir = path.resolve(cwd, commonDirResult.stdout.trim())

  return gitDir !== commonDir
}

/**
 * Get the current repository name (basename of the project root)
 */
export const getRepoName = async (): Promise<string> => {
  const projectRoot = await getProjectRoot()

  return path.basename(projectRoot)
}

/**
 * Delete a local branch if it exists and is not the current checkout.
 *
 * Idempotent: a no-op when the branch is absent (`git branch --list` prints
 * nothing). Uses force `-D` because a delivered release branch was
 * squash-merged — its tip is unreachable from the base, so `-d` would refuse
 * with "not fully merged". The delete itself still rejects if the branch is
 * checked out in another worktree; callers decide how to handle that.
 */
export const deleteLocalBranch = async (branch: string): Promise<void> => {
  const listed = await $`git branch --list ${branch}`

  if (listed.stdout.trim().length === 0) return

  if ((await getCurrentBranch()) === branch) return

  await $`git branch -D ${branch}`
}

/**
 * Delete a branch on the `origin` remote if it exists.
 *
 * Idempotent: a no-op when the branch is absent on the remote. Existence is
 * probed with `git ls-remote --heads` (empty stdout = absent) rather than
 * `--exit-code`, so a genuine network/auth failure rejects and propagates to
 * the caller instead of being silently misread as "branch absent".
 */
export const deleteRemoteBranch = async (branch: string): Promise<void> => {
  const refs = await $`git ls-remote --heads origin ${branch}`

  if (refs.stdout.trim().length === 0) return

  await $`git push origin --delete ${branch}`
}
