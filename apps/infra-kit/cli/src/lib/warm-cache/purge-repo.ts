import fs from 'node:fs'
import { $ } from 'zx'

import { getProjectWarmCacheDir } from 'src/lib/constants'
import { logger } from 'src/lib/logger'

import { canonicalizeProjectRoot } from './warm-cache'

/**
 * Warm-cache invalidation for a CREDENTIAL change (`env-token-set` / `env-token-remove`), as opposed
 * to the per-worktree invalidation `env-clear` does.
 *
 * The two keys do not line up, and that mismatch is the whole reason this exists:
 *  - the WARM CACHE is keyed per WORKTREE — a sha of the realpath'd project dir ({@link
 *    canonicalizeProjectRoot} + `warmCacheKey`), so every worktree of a repo has its OWN warm dir;
 *  - the TOKEN STORE is keyed to the MAIN repo root — one store shared by every worktree.
 *
 * So rotating a token in one worktree would leave every OTHER worktree's warm file — up to 2h of
 * plaintext secrets fetched with the OLD token — sitting on disk, ready to be sourced at the next
 * shell prompt. A fresh token would silently lose to a stale cache. Hence: enumerate the worktrees
 * from git and purge all of them.
 */

/**
 * Absolute worktree paths from `git worktree list --porcelain`, whose stanzas begin with a
 * `worktree <path>` line (the main checkout first, then each linked worktree).
 *
 * Pure, so the parse is testable without a repo.
 *
 * @example
 * parseWorktreePaths('worktree /repo\nHEAD abc\n\nworktree /repo-wt/feat\nHEAD def\n')
 * // => ['/repo', '/repo-wt/feat']
 */
export const parseWorktreePaths = (porcelain: string): string[] => {
  return porcelain
    .split('\n')
    .filter((line) => {
      return line.startsWith('worktree ')
    })
    .map((line) => {
      return line.slice('worktree '.length).trim()
    })
    .filter(Boolean)
}

/**
 * Delete the warm cache of EVERY worktree of the current repo. Returns the dirs actually removed, so
 * the caller can report the count.
 *
 * Best-effort by design: outside a git checkout (or when git fails) there are no worktrees to
 * enumerate and no warm files to lose — a token write must not fail because the purge could not run.
 * A purge that DOES fail is far less bad than a token that never gets stored.
 *
 * @example
 * await purgeRepoWarmCaches() // => ['/Users/x/.cache/infra-kit/projects/<sha>', …]
 */
export const purgeRepoWarmCaches = async (): Promise<string[]> => {
  let porcelain: string

  try {
    const result = await $({ quiet: true })`git worktree list --porcelain`

    porcelain = result.stdout
  } catch (error) {
    logger.debug(`warm-cache purge skipped (not a git repo?): ${(error as Error).message}`)

    return []
  }

  const removed: string[] = []

  for (const worktree of parseWorktreePaths(porcelain)) {
    const canonical = canonicalizeProjectRoot(worktree)

    if (!canonical) continue

    const dir = getProjectWarmCacheDir(canonical)

    try {
      if (!fs.existsSync(dir)) continue

      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch (error) {
      logger.debug(`warm-cache purge skipped for ${dir}: ${(error as Error).message}`)
    }
  }

  return removed
}
