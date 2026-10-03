import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { slugifyHostLabel } from './release-slug'

/** The `<repo>` label used outside a git repo, or when the repo's directory name slugifies to nothing. */
export const DEFAULT_REPO_SLUG = 'repo'

/**
 * The `<repo>` label for the repository `cwd` belongs to: the directory name of its MAIN checkout, so every
 * git worktree of one repo shares it (`hulyo-monorepo-worktrees/feature/x` still says `hulyo-monorepo`).
 * Falls back to {@link DEFAULT_REPO_SLUG}. Never throws.
 *
 * Read from `git rev-parse --git-common-dir` rather than `infra-kit.json`'s `envManagement` name: git is
 * already required for `<release>`, it resolves the same from any worktree or subdirectory, and the config
 * name is optional, layered, and would pull the config loader into the lightweight vite/Playwright helpers.
 *
 * @example
 * readRepoSlug('/projects/hulyo-monorepo-worktrees/feature/x/apps/web/ui') // => 'hulyo-monorepo'
 */
export const readRepoSlug = (cwd: string): string => {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const name = path.basename(commonDir)
    // `.git` (a normal checkout) or a dot-dir like `.bare` names nothing; a bare `foo.git` names the repo.
    const repoName = name.startsWith('.') ? path.basename(path.dirname(commonDir)) : name.replace(/\.git$/, '')

    return slugifyHostLabel(repoName) || DEFAULT_REPO_SLUG
  } catch {
    return DEFAULT_REPO_SLUG
  }
}
