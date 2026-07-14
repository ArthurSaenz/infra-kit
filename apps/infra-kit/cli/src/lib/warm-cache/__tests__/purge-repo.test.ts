import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { $ } from 'zx'

import { ENV_LOAD_FILE, getProjectWarmCacheDir } from 'src/lib/constants'

import { parseWorktreePaths, purgeRepoWarmCaches } from '../purge-repo'

/**
 * Deliberately NOT mocking zx: the whole point of this helper is that it enumerates REAL worktrees,
 * and a mocked `git worktree list` would only prove that the parser can read a string I typed. So
 * this builds a throwaway repo with three worktrees, plants a warm cache for each, and purges.
 *
 * The trap it was written against: the warm cache is keyed per WORKTREE (a sha of the realpath'd
 * project dir) while the token store is keyed to the MAIN repo root. A purge that only cleaned the
 * CURRENT worktree would leave the other two serving secrets fetched with the old token.
 */

let tmp: string
let repo: string
let worktrees: string[]
let originalCwd: string
const originalXdg = process.env.XDG_CACHE_HOME

/** Plant a warm cache for a worktree, exactly where `writeWarmCache` would put it. */
const seedWarmCache = (worktree: string): string => {
  const dir = getProjectWarmCacheDir(fs.realpathSync(worktree))

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, ENV_LOAD_FILE), "set -a\nSECRET='from-the-old-token'\nset +a\n", { mode: 0o600 })

  return dir
}

beforeEach(async () => {
  originalCwd = process.cwd()

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'purge-warm-')))
  process.env.XDG_CACHE_HOME = path.join(tmp, 'cache')

  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)

  await $({ cwd: repo })`git init --quiet`
  await $({ cwd: repo })`git -c user.email=t@t -c user.name=t commit --allow-empty -m init --quiet`

  // Two LINKED worktrees + the main checkout = the three the purge must find.
  const linked = [path.join(tmp, 'wt-a'), path.join(tmp, 'wt-b')]

  await $({ cwd: repo })`git worktree add -q -b feat-a ${linked[0]}`
  await $({ cwd: repo })`git worktree add -q -b feat-b ${linked[1]}`

  worktrees = [repo, ...linked]

  process.chdir(repo)
  // zx snapshots process.cwd() at import; without this, `git worktree list` inside the helper would
  // run in the REAL infra-kit repo and this whole file would be a false green.
  $.cwd = repo
})

afterEach(() => {
  process.chdir(originalCwd)
  $.cwd = undefined

  if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXdg

  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('purgeRepoWarmCaches', () => {
  it('removes the warm cache of EVERY worktree of the repo, not just the current one', async () => {
    const dirs = worktrees.map(seedWarmCache)

    expect(new Set(dirs).size, 'each worktree must have its OWN warm dir — otherwise this proves nothing').toBe(3)

    const removed = await purgeRepoWarmCaches()

    expect(removed).toHaveLength(3)

    for (const dir of dirs) {
      expect(fs.existsSync(dir), `${dir} survived the purge`).toBe(false)
    }
  })

  it('is a no-op — not a failure — when no warm cache exists', async () => {
    await expect(purgeRepoWarmCaches()).resolves.toEqual([])
  })

  it('never throws outside a git repo (a token write must not fail because the purge could not run)', async () => {
    const notARepo = path.join(tmp, 'plain')

    fs.mkdirSync(notARepo)
    $.cwd = notARepo

    await expect(purgeRepoWarmCaches()).resolves.toEqual([])
  })
})

describe('parseWorktreePaths', () => {
  it('reads the path off each porcelain stanza', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo-worktrees/feature/x',
      'HEAD def',
      'branch refs/heads/feature/x',
      '',
    ].join('\n')

    expect(parseWorktreePaths(porcelain)).toEqual(['/repo', '/repo-worktrees/feature/x'])
  })

  it('returns nothing for empty output', () => {
    expect(parseWorktreePaths('')).toEqual([])
  })
})
