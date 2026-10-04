import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { slugifyHostLabel } from './release-slug'

/** The `<repo>` label used outside a git repo, or when the repo's directory name slugifies to nothing. */
export const DEFAULT_REPO_SLUG = 'repo'

export interface RepoIdentity {
  /**
   * The repo's own directory, shared by every worktree: the main checkout, or a bare repo's `foo.git`
   * itself (never its parent, which would take in every sibling). `null` outside git and for a submodule,
   * which has no main checkout to converge on — callers fall back to their own toplevel.
   */
  root: string | null
  /** The `<repo>` alias label: {@link root}'s `infra-kit.json` `aliasRepo`, else its name minus `.git`, slugified. */
  slug: string
}

/**
 * The `aliasRepo` the main checkout's `infra-kit.json` sets, slugified, or `''` when it sets none.
 *
 * Read from the main checkout rather than the caller's worktree so every worktree names the repo alike, and
 * with a bare `JSON.parse` rather than the CLI's loader: the vite and Playwright helpers import this, and the
 * CLI's strict schema has already refused a bad value before any server registered under it.
 */
const readConfiguredRepoSlug = (root: string): string => {
  try {
    const config: unknown = JSON.parse(fs.readFileSync(path.join(root, 'infra-kit.json'), 'utf-8'))
    const aliasRepo = (config as { aliasRepo?: unknown } | null)?.aliasRepo

    return typeof aliasRepo === 'string' ? slugifyHostLabel(aliasRepo) : ''
  } catch {
    return ''
  }
}

/**
 * Which repository `cwd` belongs to, read from `git rev-parse --git-common-dir` so every worktree of one
 * repo gives the same answer (`hulyo-monorepo-worktrees/feature/x` is still `hulyo-monorepo`). Never throws.
 *
 * The one source for both the dev alias's `<repo>` label and the directories `env-load` scopes a load to,
 * so the two can never disagree about what "this repo" is. Git rather than `infra-kit.json`'s
 * `envManagement` name: git is already required for `<release>`, and the config name is optional, layered,
 * and would pull the config loader into the lightweight vite/Playwright helpers. Only the label can be
 * overridden, by `aliasRepo`, to shorten the host; `root` always comes from git.
 *
 * @example
 * readRepoIdentity('/projects/hulyo-monorepo-worktrees/feature/x/apps/web/ui')
 * // => { root: '/projects/hulyo-monorepo', slug: 'hulyo-monorepo' }
 */
export const readRepoIdentity = (cwd: string): RepoIdentity => {
  let commonDir: string

  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return { root: null, slug: DEFAULT_REPO_SLUG }
  }

  const name = path.basename(commonDir)

  if (commonDir.includes(`${path.sep}.git${path.sep}modules${path.sep}`)) {
    return { root: null, slug: slugifyHostLabel(name) || DEFAULT_REPO_SLUG }
  }

  // `.git` (a normal checkout) or a dot-dir like `.bare` sits inside the repo's directory; anything else is
  // a bare repo, which is its own directory.
  const root = name.startsWith('.') ? path.dirname(commonDir) : commonDir

  return {
    root,
    slug:
      readConfiguredRepoSlug(root) || slugifyHostLabel(path.basename(root).replace(/\.git$/, '')) || DEFAULT_REPO_SLUG,
  }
}

/** The `<repo>` alias label — {@link readRepoIdentity}'s `slug`. */
export const readRepoSlug = (cwd: string): string => {
  return readRepoIdentity(cwd).slug
}
