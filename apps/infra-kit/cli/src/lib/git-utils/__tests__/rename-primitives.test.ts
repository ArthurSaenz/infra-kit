import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { $ } from 'zx'

import { moveWorktree, renameLocalBranch, setUpstream } from '../git-utils'
import { deleteRemoteBranchWithLease, lsRemoteHead } from '../merge-refs'
import { hasMergeInProgress, hasOperationInProgress } from '../scratch-worktree'

/** Real git with a real bare origin: each claim is about git's behaviour, which a mock would only restate. */

const tmpRoots: string[] = []

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await $({ cwd, quiet: true })`git ${args}`

  return result.stdout.trim()
}

const commit = async (cwd: string, file: string, message: string): Promise<void> => {
  await fs.writeFile(path.join(cwd, file), `${message}\n`)
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-qm', message)
}

const cloneOf = async (origin: string, dest: string): Promise<void> => {
  await $({ quiet: true })`git clone -q ${origin} ${dest}`
  await git(dest, 'config', 'user.email', 'test@example.com')
  await git(dest, 'config', 'user.name', 'Test')
}

const makeFixture = async (): Promise<{ root: string; repo: string; origin: string }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-rename-'))

  tmpRoots.push(root)

  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'work')

  await $({ quiet: true })`git init -q --bare ${origin}`
  await cloneOf(origin, repo)
  await commit(repo, 'a.txt', 'base')
  await git(repo, 'branch', '-M', 'dev')
  await git(repo, 'push', '-q', '-u', 'origin', 'dev')
  await git(repo, 'switch', '-qc', 'release/v1.0.0')
  await commit(repo, 'r.txt', 'release')
  await git(repo, 'push', '-q', '-u', 'origin', 'release/v1.0.0')
  await git(repo, 'switch', '-q', 'dev')

  return { root, repo, origin }
}

afterAll(async () => {
  await Promise.all(
    tmpRoots.map((dir) => {
      return fs.rm(dir, { recursive: true, force: true })
    }),
  )
})

describe('deleteRemoteBranchWithLease', () => {
  it('deletes the branch when origin still holds the expected sha', async () => {
    const { repo } = await makeFixture()
    const sha = await git(repo, 'rev-parse', 'release/v1.0.0')

    const result = await deleteRemoteBranchWithLease(repo, 'release/v1.0.0', sha)

    expect(result.deleted).toBe(true)
    expect(await lsRemoteHead(repo, 'release/v1.0.0')).toBeNull()
  })

  it('returns deleted:false and keeps the branch when another clone pushed first', async () => {
    const { root, repo, origin } = await makeFixture()
    const expected = await git(repo, 'rev-parse', 'release/v1.0.0')
    const other = path.join(root, 'other')

    await cloneOf(origin, other)
    await git(other, 'switch', '-q', 'release/v1.0.0')
    await commit(other, 'teammate.txt', 'teammate')
    await git(other, 'push', '-q', 'origin', 'release/v1.0.0')

    const moved = await git(other, 'rev-parse', 'HEAD')
    const result = await deleteRemoteBranchWithLease(repo, 'release/v1.0.0', expected)

    expect(result.deleted).toBe(false)
    expect(result.stderr).toBeTruthy()
    expect(await lsRemoteHead(repo, 'release/v1.0.0')).toBe(moved)
  })
})

describe('renameLocalBranch and setUpstream', () => {
  it('leaves the renamed branch tracking the given upstream', async () => {
    const { repo } = await makeFixture()

    await git(repo, 'push', '-q', 'origin', 'release/v1.0.0:refs/heads/release/v1.0.1')
    await git(repo, 'fetch', '-q', 'origin')
    await renameLocalBranch(repo, 'release/v1.0.0', 'release/v1.0.1')
    await setUpstream(repo, 'release/v1.0.1', 'origin/release/v1.0.1')

    expect(await git(repo, 'rev-parse', '--abbrev-ref', 'release/v1.0.1@{upstream}')).toBe('origin/release/v1.0.1')
    expect(await git(repo, 'branch', '--list', 'release/v1.0.0')).toBe('')
  })

  it('throws when the target branch already exists instead of clobbering it', async () => {
    const { repo } = await makeFixture()

    await expect(renameLocalBranch(repo, 'release/v1.0.0', 'dev')).rejects.toThrow()
  })
})

describe('moveWorktree', () => {
  it('moves a linked worktree into a missing parent dir and keeps untracked files', async () => {
    const { root, repo } = await makeFixture()
    const from = path.join(root, 'wt', 'release', 'v1.0.0')
    const to = path.join(root, 'wt-new', 'deep', 'v1.0.1')

    await fs.mkdir(path.dirname(from), { recursive: true })
    await git(repo, 'worktree', 'add', '-q', from, 'release/v1.0.0')
    await fs.writeFile(path.join(from, 'untracked.txt'), 'keep me')

    await moveWorktree(repo, from, to)

    expect(await fs.readFile(path.join(to, 'untracked.txt'), 'utf8')).toBe('keep me')
    await expect(fs.access(from)).rejects.toThrow()
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain(await fs.realpath(to))
  })
})

describe('hasOperationInProgress', () => {
  it('is false on a clean linked worktree', async () => {
    const { root, repo } = await makeFixture()
    const wt = path.join(root, 'wt-clean')

    await git(repo, 'worktree', 'add', '-q', wt, 'release/v1.0.0')

    expect(await hasOperationInProgress(wt)).toBe(false)
  })

  it('is true during a stopped rebase inside a linked worktree', async () => {
    const { root, repo } = await makeFixture()
    const wt = path.join(root, 'wt-rebase')

    await git(repo, 'worktree', 'add', '-q', wt, 'release/v1.0.0')
    await $({
      cwd: wt,
      quiet: true,
      env: { ...process.env, GIT_SEQUENCE_EDITOR: ':', GIT_EDITOR: ':' },
    })`git rebase --exec false HEAD~1`.catch(() => {
      return undefined
    })

    expect(await hasOperationInProgress(wt)).toBe(true)
  })

  it('is true when MERGE_HEAD is present, and hasMergeInProgress agrees', async () => {
    const { repo } = await makeFixture()
    const head = await git(repo, 'rev-parse', 'HEAD')

    expect(await hasOperationInProgress(repo)).toBe(false)
    expect(await hasMergeInProgress(repo)).toBe(false)

    await fs.writeFile(path.join(repo, '.git', 'MERGE_HEAD'), `${head}\n`)

    expect(await hasOperationInProgress(repo)).toBe(true)
    expect(await hasMergeInProgress(repo)).toBe(true)
  })
})
