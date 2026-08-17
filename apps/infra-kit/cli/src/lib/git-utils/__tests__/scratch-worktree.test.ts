import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'

import {
  assertPristineWorktree,
  hasMergeInProgress,
  resetScratchWorktree,
  scratchWorktreePath,
  withScratchWorktree,
} from '../scratch-worktree'

/**
 * Real temporary repositories, not command-string mocks.
 *
 * Everything asserted here is a claim about git's behaviour — that a detached
 * worktree can be created while the same branch is checked out elsewhere, that an
 * unaborted conflict poisons the next checkout, that `reset --hard` leaves
 * untracked files. A mock would encode our *belief* about each of those and keep
 * passing when the belief is wrong, which is exactly how the defect this module
 * replaces survived review.
 */

const tmpRoots: string[] = []

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await $({ cwd, quiet: true })`git ${args}`

  return result.stdout.trim()
}

/** A bare origin plus a clone with `dev` and two release branches. */
const makeFixture = async (): Promise<{ repo: string; origin: string }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-scratch-'))

  tmpRoots.push(root)

  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'work')

  await $({ quiet: true })`git init -q --bare ${origin}`
  await $({ quiet: true })`git clone -q ${origin} ${repo}`

  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')

  await fs.writeFile(path.join(repo, 'a.txt'), 'base\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'base')
  await git(repo, 'branch', '-M', 'dev')
  await git(repo, 'push', '-q', '-u', 'origin', 'dev')

  // Each release branch forks from `dev` and edits the SAME line, so any two of
  // them genuinely conflict. Branching them off each other instead would make
  // the "conflict" cases fast-forward silently and the cascade test vacuous.
  for (const version of ['1.0.0', '1.1.0']) {
    await git(repo, 'switch', '-q', 'dev')
    await git(repo, 'switch', '-qc', `release/v${version}`)
    await fs.writeFile(path.join(repo, 'a.txt'), `base\nrelease ${version}\n`)
    await git(repo, 'commit', '-qam', `release ${version}`)
    await git(repo, 'push', '-q', '-u', 'origin', `release/v${version}`)
  }

  await git(repo, 'switch', '-q', 'dev')
  await fs.writeFile(path.join(repo, 'b.txt'), 'from dev\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'dev work')
  await git(repo, 'push', '-q', 'origin', 'dev')
  await git(repo, 'fetch', '-q', 'origin')

  return { repo, origin }
}

const worktreePaths = async (repo: string): Promise<string[]> => {
  const out = await git(repo, 'worktree', 'list', '--porcelain')

  return out
    .split('\n')
    .filter((line) => {
      return line.startsWith('worktree ')
    })
    .map((line) => {
      return line.slice('worktree '.length)
    })
}

beforeEach(() => {
  // Deterministic, per-test scratch id (the production default is the session id).
  process.env.INFRA_KIT_SESSION = `test${Math.floor(Date.now() % 100000)}`
})

afterAll(async () => {
  await Promise.all(
    tmpRoots.map((root) => {
      return fs.rm(root, { recursive: true, force: true })
    }),
  )
})

describe('scratchWorktreePath', () => {
  it('lives under the git common dir, so it is invisible to `git status`', async () => {
    const { repo } = await makeFixture()

    const scratch = await scratchWorktreePath(repo)

    expect(scratch).toContain(path.join('.git', 'infra-kit', 'merge-dev-'))

    // The load-bearing property: an untracked dir in the main checkout would make
    // isWorkingTreeClean false for every other release command in this CLI.
    await fs.mkdir(scratch, { recursive: true })
    expect(await git(repo, 'status', '--porcelain')).toBe('')
  })

  it('is unique per run, so two concurrent runs cannot collide', async () => {
    const { repo } = await makeFixture()

    process.env.INFRA_KIT_SESSION = 'aaaa1111'
    const first = await scratchWorktreePath(repo)

    process.env.INFRA_KIT_SESSION = 'bbbb2222'
    const second = await scratchWorktreePath(repo)

    expect(first).not.toBe(second)
  })
})

describe('withScratchWorktree', () => {
  it('creates a detached checkout even while every release branch is checked out elsewhere', async () => {
    const { repo } = await makeFixture()

    // Reproduce this team's normal layout: the branch is already occupied.
    const occupied = path.join(path.dirname(repo), 'occupied')

    await git(repo, 'worktree', 'add', '-q', occupied, 'release/v1.0.0')

    // The occupying worktree is PRISTINE — nothing staged, nothing modified.
    expect(await git(occupied, 'status', '--porcelain')).toBe('')

    // And the old engine still fails outright. git's rule is about the branch
    // being checked out ANYWHERE, not about whether that checkout has changes,
    // so "the worktree is clean" is not a condition anything could test its way
    // out of. Capturing the exact wording because it is what a human sees.
    const switchError = await git(repo, 'switch', 'release/v1.0.0').catch((error: unknown) => {
      return String((error as { stderr?: string }).stderr ?? error)
    })

    expect(switchError).toMatch(/is already used by worktree at/)

    const seen = await withScratchWorktree({ cwd: repo }, async (worktree) => {
      await git(worktree.path, 'checkout', '--detach', 'origin/release/v1.0.0')

      return git(worktree.path, 'rev-parse', 'HEAD')
    })

    expect(seen).toBe(await git(repo, 'rev-parse', 'origin/release/v1.0.0'))
  })

  it('removes the worktree even when the callback throws', async () => {
    const { repo } = await makeFixture()
    const before = await worktreePaths(repo)

    await expect(
      withScratchWorktree({ cwd: repo }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await worktreePaths(repo)).toEqual(before)
  })

  it('recovers from a stale registration left by a hard kill', async () => {
    const { repo } = await makeFixture()
    const scratch = await scratchWorktreePath(repo)

    // Simulate SIGKILL mid-run: the registration survives, the directory does not.
    await git(repo, 'worktree', 'add', '--detach', '-q', scratch, 'origin/dev')
    await fs.rm(scratch, { recursive: true, force: true })

    // Without prune-and-retry this is `fatal: … is a missing but already
    // registered worktree`, and the command stays broken on that machine forever.
    const ok = await withScratchWorktree({ cwd: repo }, async (worktree) => {
      return git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')
    })

    expect(ok).toBe('HEAD')
  })
})

describe('resetScratchWorktree / assertPristineWorktree', () => {
  it('clears a conflicted merge so the NEXT branch is unaffected — the cascade guard', async () => {
    const { repo } = await makeFixture()

    await withScratchWorktree({ cwd: repo }, async (worktree) => {
      // Branch 1 conflicts: both sides edited a.txt.
      await git(worktree.path, 'checkout', '--detach', 'origin/release/v1.0.0')
      await expect(git(worktree.path, 'merge', 'origin/release/v1.1.0', '--no-edit')).rejects.toBeDefined()
      expect(await hasMergeInProgress(worktree.path)).toBe(true)

      await resetScratchWorktree(worktree.path)

      // Without the reset this is `error: you need to resolve your current index
      // first`, and every later branch would report an error it did not cause.
      await expect(assertPristineWorktree(worktree.path)).resolves.toBeUndefined()
      await expect(git(worktree.path, 'checkout', '--detach', 'origin/release/v1.1.0')).resolves.toBeDefined()
    })
  })

  it('removes untracked files that `reset --hard` alone would leave behind', async () => {
    const { repo } = await makeFixture()

    await withScratchWorktree({ cwd: repo }, async (worktree) => {
      await fs.writeFile(path.join(worktree.path, 'stray.txt'), 'left over\n')

      await resetScratchWorktree(worktree.path)

      await expect(assertPristineWorktree(worktree.path)).resolves.toBeUndefined()
    })
  })

  it('refuses a dirty scratch worktree rather than cascading', async () => {
    const { repo } = await makeFixture()

    await withScratchWorktree({ cwd: repo }, async (worktree) => {
      await fs.writeFile(path.join(worktree.path, 'a.txt'), 'uncommitted\n')

      await expect(assertPristineWorktree(worktree.path)).rejects.toBeInstanceOf(OperationError)
    })
  })
})
