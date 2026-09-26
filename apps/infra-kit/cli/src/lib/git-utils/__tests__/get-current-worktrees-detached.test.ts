import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { worktreesRemove } from 'src/commands/worktrees-remove/worktrees-remove'
import { worktreesSync } from 'src/commands/worktrees-sync/worktrees-sync'
import { getReleasePRs, getReleasePRsWithInfo } from 'src/integrations/gh'
import { WORKTREES_DIR_SUFFIX, WORKTREE_SUBDIRS } from 'src/lib/constants'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'

import { getCurrentWorktrees } from '../git-utils'

/**
 * A regression for a detached worktree living under `<root>-worktrees/merge-dev/…` (the scratch
 * layout `gh merge-dev` uses, and the scaffold `init` now lays out — see `WORKTREE_SUBDIRS`).
 *
 * Deliberately NOT mocking zx or git-utils: the claim under test is about git's own porcelain output
 * (a detached checkout reports `branch: null`) and about `worktrees sync`/`worktrees remove`'s real
 * removal path never reaching a path `getCurrentWorktrees('release')` never named. A mocked
 * `getCurrentWorktrees` would only prove this file's own fixture, not the filtering it exercises.
 * Only genuinely external integrations (gh, Orca) are mocked.
 */

vi.mock('src/integrations/gh', () => {
  return { getReleasePRs: vi.fn(), getReleasePRsWithInfo: vi.fn() }
})

// `probeOrca` is the one seam worth faking: left real it would try to spawn the `orca` CLI. Every
// other export stays real — with a non-`ready` probe and no `ORCA_WORKTREE_ID` in this process's
// env, `closeOrcaWorktreeTerminals`/`orcaCallerInsideTargets` already short-circuit before reaching
// Orca, so faking them too would hide a real regression in that short-circuit itself.
vi.mock('src/integrations/orca', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/orca')>()

  return {
    ...actual,
    probeOrca: vi.fn(async () => {
      return 'unreachable'
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const RELEASE_BRANCH = 'release/v1.0.0'
const MERGE_DEV_SUBPATH = path.join(WORKTREE_SUBDIRS.mergeDev, 'release-v1-2-3')

let tmp: string
let repo: string
let home: string
let worktreeDir: string
let originalCwd: string

const git = (cwd: string) => {
  return $({ cwd, quiet: true })
}

/** Every path git still lists as a worktree of `repo`, straight from the porcelain format. */
const registeredWorktreePaths = async (): Promise<string[]> => {
  const output = await git(repo)`git worktree list --porcelain`

  return output.stdout
    .split('\n')
    .filter((line) => {
      return line.startsWith('worktree ')
    })
    .map((line) => {
      return line.slice('worktree '.length)
    })
}

/** The scratch-style detached checkout: no branch, so `isReleaseBranch` can never match it. */
const addDetachedMergeDevWorktree = async (): Promise<string> => {
  const worktreePath = path.join(worktreeDir, MERGE_DEV_SUBPATH)

  await git(repo)`git worktree add -q --detach ${worktreePath} HEAD`

  return worktreePath
}

/** A real, addressable release worktree — the thing `worktrees sync`/`remove` are supposed to act on. */
const addReleaseWorktree = async (): Promise<string> => {
  const worktreePath = path.join(worktreeDir, RELEASE_BRANCH)

  await git(repo)`git worktree add -q -b ${RELEASE_BRANCH} ${worktreePath}`

  return worktreePath
}

beforeEach(async () => {
  vi.clearAllMocks()
  originalCwd = process.cwd()

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-detached-')))
  repo = path.join(tmp, 'repo')
  home = path.join(tmp, 'home')
  worktreeDir = `${repo}${WORKTREES_DIR_SUFFIX}`

  fs.mkdirSync(repo)
  fs.mkdirSync(home)

  await git(repo)`git init --quiet`
  await git(repo)`git -c user.email=t@t -c user.name=t commit --allow-empty -qm init`

  fs.writeFileSync(
    path.join(repo, 'infra-kit.json'),
    JSON.stringify({ envManagement: { provider: 'doppler', config: { name: 'wt-detached' } } }),
  )
  // `assertManagementContext` refuses a dirty checkout, so this has to be committed, not just present.
  await git(repo)`git add infra-kit.json`
  await git(repo)`git -c user.email=t@t -c user.name=t commit -qm config`

  // zx snapshots process.cwd() at import; every `git` call the commands under test make (no explicit
  // `cwd`) must land in the throwaway repo, not in the real infra-kit checkout.
  process.chdir(repo)
  $.cwd = repo

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  resetInfraKitConfigCache()

  vi.mocked(getReleasePRs).mockResolvedValue([])
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])
})

afterEach(() => {
  process.chdir(originalCwd)
  $.cwd = undefined
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a detached worktree under <root>-worktrees/merge-dev', () => {
  it('is absent from getCurrentWorktrees("release") — branch is null, so it can never match', async () => {
    const detachedPath = await addDetachedMergeDevWorktree()

    expect(fs.existsSync(detachedPath)).toBe(true)
    await expect(getCurrentWorktrees('release')).resolves.toEqual([])
  })

  it('worktreesSync removes a stale release worktree but leaves the detached one and its git registration alone', async () => {
    const detachedPath = await addDetachedMergeDevWorktree()
    const releasePath = await addReleaseWorktree()

    // The release PR is closed (no longer in the mocked "open PRs" list), so sync has something real
    // to remove — proving the detached worktree survives is only meaningful alongside one that doesn't.
    vi.mocked(getReleasePRs).mockResolvedValue([])

    await worktreesSync({ confirmedCommand: true })

    expect(fs.existsSync(releasePath)).toBe(false)
    expect(fs.existsSync(detachedPath)).toBe(true)

    const registered = await registeredWorktreePaths()

    expect(registered).not.toContain(releasePath)
    expect(registered).toContain(detachedPath)
  })

  it('worktreesRemove({ all: true }) removes every release worktree but leaves the detached one and its git registration alone', async () => {
    const detachedPath = await addDetachedMergeDevWorktree()
    const releasePath = await addReleaseWorktree()

    await worktreesRemove({ confirmedCommand: true, all: true })

    expect(fs.existsSync(releasePath)).toBe(false)
    expect(fs.existsSync(detachedPath)).toBe(true)

    const registered = await registeredWorktreePaths()

    expect(registered).not.toContain(releasePath)
    expect(registered).toContain(detachedPath)
  })
})
