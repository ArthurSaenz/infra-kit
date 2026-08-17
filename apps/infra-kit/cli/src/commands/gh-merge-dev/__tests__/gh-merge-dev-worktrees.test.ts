import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { assertRepoWithOrigin } from 'src/lib/git-guard'
import { getMainRepoRoot, scratchWorktreePath } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'

import { ghMergeDev } from '../gh-merge-dev'

/**
 * End-to-end proof, against real repositories, that the defect this whole change
 * exists for is gone at the COMMAND level rather than only in the primitives.
 *
 * The defect: `gh-merge-dev` merged by switching branches in the main checkout.
 * Because `worktrees-add` keeps a worktree per release branch, "this branch is
 * already checked out somewhere" is the team's DEFAULT state, so `git switch`
 * failed on the ordinary case rather than an exceptional one — `fatal: '<b>' is
 * already used by worktree at '<path>'`.
 *
 * Only the two genuine boundaries are mocked: the GitHub PR listing (network) and
 * the repo-root lookup (so the command operates on the fixture). The scratch
 * worktree, the merges, the reclassification and the push are all real git.
 */

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/lib/git-guard', () => {
  return { assertRepoWithOrigin: vi.fn(), assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/git-utils')>()

  return { ...actual, getMainRepoRoot: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const tmpRoots: string[] = []

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await $({ cwd, quiet: true })`git ${args}`

  return result.stdout.trim()
}

const RELEASES = ['release/v1.0.0', 'release/v1.1.0']

const makeFixture = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-cmd-'))

  tmpRoots.push(root)

  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'work')

  await $({ quiet: true })`git init -q --bare ${origin}`
  await $({ quiet: true })`git clone -q ${origin} ${repo}`
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')

  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'base')
  await git(repo, 'branch', '-M', 'dev')
  await git(repo, 'push', '-q', '-u', 'origin', 'dev')

  for (const branch of RELEASES) {
    await git(repo, 'switch', '-q', 'dev')
    await git(repo, 'switch', '-qc', branch)
    await fs.writeFile(path.join(repo, `${branch.replace(/\W/g, '-')}.txt`), branch)
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', branch)
    await git(repo, 'push', '-q', '-u', 'origin', branch)
  }

  await git(repo, 'switch', '-q', 'dev')
  await fs.writeFile(path.join(repo, 'from-dev.txt'), 'dev work\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'dev work')
  await git(repo, 'push', '-q', 'origin', 'dev')
  await git(repo, 'fetch', '-q', 'origin')

  return repo
}

/** Every release branch carries origin/dev afterwards — the run's whole purpose. */
const assertAllMerged = async (repo: string): Promise<void> => {
  await git(repo, 'fetch', '-q', 'origin')

  for (const branch of RELEASES) {
    await expect(git(repo, 'merge-base', '--is-ancestor', 'origin/dev', `origin/${branch}`)).resolves.toBeDefined()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INFRA_KIT_SESSION = `cmd${Math.floor(Date.now() % 100000)}`
  vi.mocked(assertRepoWithOrigin).mockResolvedValue(undefined)
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue(
    RELEASES.map((branch, index) => {
      return { branch, title: `Release ${branch}`, createdAt: `2024-01-0${index + 1}T00:00:00Z` }
    }),
  )
})

afterAll(async () => {
  await Promise.all(
    tmpRoots.map((root) => {
      return fs.rm(root, { recursive: true, force: true })
    }),
  )
})

describe('gh-merge-dev against occupied worktrees', () => {
  it('completes with `dev` checked out in a linked worktree', async () => {
    const repo = await makeFixture()

    vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

    // The old engine's very first step was `git switch dev`. Prove it would fail
    // here before proving the command no longer cares.
    const devWorktree = path.join(path.dirname(repo), 'wt-dev')

    await git(repo, 'switch', '-q', 'release/v1.0.0')
    await git(repo, 'worktree', 'add', '-q', devWorktree, 'dev')
    await expect(git(repo, 'switch', 'dev')).rejects.toBeDefined()

    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    expect(result.structuredContent.failedMerges).toBe(0)
    expect(result.structuredContent.successfulMerges).toBe(2)
    await assertAllMerged(repo)
  })

  it('completes with EVERY release branch checked out in a linked worktree', async () => {
    const repo = await makeFixture()

    vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

    for (const branch of RELEASES) {
      await git(repo, 'worktree', 'add', '-q', path.join(path.dirname(repo), branch.replace(/\W/g, '-')), branch)
    }

    // This is the team's ordinary layout, and the exact state the old command
    // reported as a failed branch with a manual merge script.
    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    expect(result.structuredContent.failedMerges).toBe(0)
    await assertAllMerged(repo)
  })

  it('completes with uncommitted changes in the main checkout', async () => {
    const repo = await makeFixture()

    vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

    await fs.writeFile(path.join(repo, 'base.txt'), 'work in progress\n')
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'scratch\n')

    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    expect(result.structuredContent.failedMerges).toBe(0)
    await assertAllMerged(repo)

    // And the operator's work is untouched: the command owns no part of this tree.
    expect(await fs.readFile(path.join(repo, 'base.txt'), 'utf8')).toBe('work in progress\n')
    expect(await git(repo, 'status', '--porcelain')).toContain('untracked.txt')
  })

  it('leaves HEAD, the working tree and the worktree list exactly as it found them', async () => {
    const repo = await makeFixture()

    vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

    const headBefore = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
    const worktreesBefore = await git(repo, 'worktree', 'list', '--porcelain')

    await ghMergeDev({ all: true, confirmedCommand: true })

    expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(headBefore)
    expect(await git(repo, 'status', '--porcelain')).toBe('')

    // The scratch worktree is created and removed within the run; a leaked
    // registration would break every subsequent run on this machine.
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
  })

  it('pushes nothing on --dry-run, however many worktrees are in the way', async () => {
    const repo = await makeFixture()

    vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

    // Snapshot EVERY local ref, not just the ones we expect to be interesting —
    // a dry run that quietly moved some other ref would slip past a narrow check.
    const localRefsBefore = await git(repo, 'show-ref')
    const worktreesBefore = await git(repo, 'worktree', 'list', '--porcelain')
    const originBefore = await Promise.all(
      RELEASES.map((branch) => {
        return git(repo, 'rev-parse', `origin/${branch}`)
      }),
    )

    const result = await ghMergeDev({ all: true, dryRun: true, confirmedCommand: true })

    expect(result.structuredContent.dryRun).toBe(true)

    expect(await git(repo, 'show-ref')).toBe(localRefsBefore)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)

    await git(repo, 'fetch', '-q', 'origin')

    const originAfter = await Promise.all(
      RELEASES.map((branch) => {
        return git(repo, 'rev-parse', `origin/${branch}`)
      }),
    )

    expect(originAfter).toEqual(originBefore)
  })

  it('recovers from a scratch worktree left registered by a hard kill', async () => {
    const repo = await makeFixture()

    vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

    // Simulate SIGKILL mid-run: the registration survives, the directory does not.
    // Without prune-and-retry the command is broken on this machine every run
    // after, with a message naming git internals rather than a remedy.
    const scratch = await scratchWorktreePath(repo)

    await git(repo, 'worktree', 'add', '--detach', '-q', scratch, 'origin/dev')
    await fs.rm(scratch, { recursive: true, force: true })

    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    expect(result.structuredContent.failedMerges).toBe(0)
    await assertAllMerged(repo)
  })
})

describe('the printed recipe is worktree-aware', () => {
  it('names `git -C <worktree>` for an occupied branch, never a `git switch` that would fail', async () => {
    const repo = await makeFixture()

    vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

    // Make release/v1.0.0 genuinely conflict with dev, so it lands in the
    // failed set and the report prints a recipe for it.
    await git(repo, 'switch', '-q', 'release/v1.0.0')
    await fs.writeFile(path.join(repo, 'base.txt'), 'from the release\n')
    await git(repo, 'commit', '-qam', 'release edit')
    await git(repo, 'push', '-q', 'origin', 'release/v1.0.0')

    await git(repo, 'switch', '-q', 'dev')
    await fs.writeFile(path.join(repo, 'base.txt'), 'from dev\n')
    await git(repo, 'commit', '-qam', 'dev edit')
    await git(repo, 'push', '-q', 'origin', 'dev')
    await git(repo, 'fetch', '-q', 'origin')

    // …and put that branch in a worktree, which is this team's normal layout.
    const occupied = path.join(path.dirname(repo), 'occupied-1-0-0')

    await git(repo, 'worktree', 'add', '-q', occupied, 'release/v1.0.0')

    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    expect(result.structuredContent.failedBranches).toContain('release/v1.0.0')

    const printed = vi.mocked(logger.info).mock.calls.flat().join('\n')

    // The blanket `git switch release/v1.0.0` form is exactly the command that
    // fails on an occupied branch — handing it back would be advice to redo the
    // broken workflow this change removed.
    // macOS resolves /var → /private/var, and git reports the realpath while
    // os.tmpdir() hands back the symlink. Comparing the raw paths fails on a
    // feature that works — the same realpath asymmetry this repo has hit before.
    const occupiedReal = await fs.realpath(occupied)

    expect(printed).toContain(`git -C ${occupiedReal} merge origin/dev`)
    expect(printed).not.toContain('git switch release/v1.0.0 &&')
  })
})
