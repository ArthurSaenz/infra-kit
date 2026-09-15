import path from 'node:path'
import process from 'node:process'
import { $ } from 'zx'

import { isAgentMode } from 'src/lib/agent-mode'
import { OperationError, extractStderr } from 'src/lib/errors/operation-error'
import { isReleaseBranch } from 'src/lib/release-id'

/**
 * A single record from `git worktree list --porcelain`. The porcelain format is
 * the source of truth for worktrees: it carries the absolute `path` (which the
 * human format's `[branch]` scrape discards), and it distinguishes detached /
 * bare / prunable / locked states that the scrape collapses to `null`.
 *
 * `branch` is the short name (`release/v1.2.3`, `feature/x`) with `refs/heads/`
 * stripped, or `null` for a detached, bare, or otherwise branch-less checkout.
 */
export interface WorktreeEntry {
  path: string
  branch: string | null
  detached: boolean
  bare: boolean
  prunable: boolean
  locked: boolean
}

/**
 * List every git worktree of the repo containing `cwd`, parsed from
 * `git worktree list --porcelain`.
 *
 * Porcelain is a stable, documented, line-oriented format: one record per
 * worktree, records separated by a blank line, each opening with a
 * `worktree <abs-path>` line. Attribute lines (`branch`, `detached`, `bare`,
 * `locked`, `prunable`) follow. This replaces the legacy `endsWith(']')` scrape
 * of the human format, which lost the path and returned `null` for detached
 * worktrees.
 *
 * The main checkout is included in the output (as its own record), exactly as
 * git reports it.
 */
export const listWorktrees = async (cwd: string): Promise<WorktreeEntry[]> => {
  const output = await $({ cwd })`git worktree list --porcelain`

  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null

  for (const line of output.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      // A new record opens; flush the previous one.
      if (current) entries.push(current)

      current = {
        path: line.slice('worktree '.length),
        branch: null,
        detached: false,
        bare: false,
        prunable: false,
        locked: false,
      }

      continue
    }

    if (!current) continue

    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'detached') {
      current.detached = true
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true
    }
  }

  if (current) entries.push(current)

  return entries
}

/**
 * Get current git worktrees
 *
 * Thin wrapper over {@link listWorktrees}: harvests branch names from the
 * porcelain records and filters by release / feature shape. Detached, bare, and
 * branch-less records drop out naturally (their `branch` is `null`).
 *
 * @returns [release/v1.18.22, release/v1.18.23, release/v1.18.24] or [feature/mobile-app, feature/explore-page, feature/login-page]
 */
export const getCurrentWorktrees = async (type: 'release' | 'feature'): Promise<string[]> => {
  const entries = await listWorktrees(process.cwd())

  const matches = (branch: string): boolean => {
    return type === 'release' ? isReleaseBranch(branch) : branch.startsWith('feature/')
  }

  return entries
    .map((entry) => {
      return entry.branch
    })
    .filter((branch): branch is string => {
      return branch !== null && matches(branch)
    })
}

/**
 * Trim git's `not a git repository (or any of the parent directories): .git` tail — and ONLY that.
 * Returns undefined for every other failure so `OperationError` falls through to the real stderr:
 * dubious ownership, EACCES, a corrupt repo, and a missing `git` binary must each report themselves.
 */
const normalizeGitRootStderr = (error: unknown): string | undefined => {
  const raw = extractStderr(error)

  return raw && /not a git repository/i.test(raw) ? 'not a git repository' : undefined
}

/**
 * Remediation text for a failed project-root resolution.
 *
 * Channel-aware: an agent is told which action it has (`-C <dir>`, or re-running from the project
 * directory) rather than to "cd", which a fixed-cwd caller cannot do.
 *
 * `hasStderr` gates the stderr-referencing clause: with no stderr (missing `git`
 * binary, ENOENT) the message must not point at evidence it does not carry.
 */
const projectRootRemediation = ({ hasStderr }: { hasStderr: boolean }): string => {
  if (isAgentMode()) {
    return 'infra-kit resolves its project from the working directory; run it from inside an infra-kit project repo (or one of its git worktrees), or pass `-C <dir>` naming one'
  }

  const base = 'run infra-kit from inside an infra-kit project repo (or one of its git worktrees)'

  return hasStderr ? `${base}; if you are already in one, the stderr in this message is the real cause` : base
}

/**
 * Get the current project root directory
 */
export const getProjectRoot = async (): Promise<string> => {
  try {
    const result = await $({ quiet: true })`git rev-parse --show-toplevel`

    return result.stdout.trim()
  } catch (error) {
    const stderrExcerpt = normalizeGitRootStderr(error) ?? extractStderr(error)

    throw new OperationError(error, {
      operation: `resolve the project root from ${process.cwd()}`,
      stderrExcerpt,
      remediation: projectRootRemediation({ hasStderr: stderrExcerpt !== undefined }),
    })
  }
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
  const commonDir = (await $({ cwd: root, quiet: true })`git rev-parse --git-common-dir`).stdout.trim()
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
 * The working tree's `git status --porcelain` lines: staged, unstaged, and untracked
 * changes, one entry per path. Empty means clean.
 *
 * The porcelain output is returned rather than reduced to a boolean because every refusal
 * built on it has to name the paths that block the operation — an operator told only
 * "working tree has uncommitted changes" has to run `git status` themselves to act on it.
 */
export const getWorkingTreeStatus = async (): Promise<string[]> => {
  const result = await $`git status --porcelain`

  // Only the trailing whitespace is stripped. The two leading columns are the status itself —
  // ` M` is "modified in the worktree" and `M ` is "modified and staged" — so trimming the left
  // side would render the first as the second in a message whose whole job is to tell the
  // operator what is in their way.
  return result.stdout
    .split('\n')
    .map((line) => {
      return line.trimEnd()
    })
    .filter((line) => {
      return line.trim().length > 0
    })
}

/**
 * Whether the working tree has no staged, unstaged, or untracked changes.
 */
export const isWorkingTreeClean = async (): Promise<boolean> => {
  return (await getWorkingTreeStatus()).length === 0
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
 * Basename of the CURRENT worktree's toplevel — a linked worktree returns the worktree dir name,
 * not the repository. Not a repo identity; see {@link getMainRepoRoot} for the stable root.
 *
 * @deprecated It has no production caller: its last one fed `local-deploy` preflight the release
 * name instead of the project. Kept only because the test suite still imports it.
 */
export const getRepoName = async (): Promise<string> => {
  const projectRoot = await getProjectRoot()

  return path.basename(projectRoot)
}

/**
 * Check whether a local branch exists.
 *
 * `deleteLocalBranch` fails open: it silently returns without deleting when
 * the branch is the current checkout or already absent, and either way its
 * `void` return gives the caller no way to tell "deleted" apart from "did
 * nothing". A caller that must not report an unperformed deletion — such as
 * a teardown command confirming a branch is actually gone — needs this
 * independent check rather than trusting `deleteLocalBranch`'s outcome.
 */
export const branchExists = async (branch: string): Promise<boolean> => {
  const listed = await $`git branch --list ${branch}`

  return listed.stdout.trim().length > 0
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
