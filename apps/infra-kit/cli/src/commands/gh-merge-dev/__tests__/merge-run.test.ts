import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { $ } from 'zx'

import { withScratchWorktree } from 'src/lib/git-utils'

import { planMergeRun, pushableRefs, reclassify } from '../merge-run'

/**
 * Real repositories. The claims under test are all claims about git — that a
 * conflicted merge poisons the next checkout unless cleaned, that a strictly
 * behind branch fast-forwards, that a detached merge writes "into HEAD" unless
 * `-m` is passed. A command-string mock would encode our belief about each and
 * keep passing when the belief is wrong.
 */

const tmpRoots: string[] = []

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await $({ cwd, quiet: true })`git ${args}`

  return result.stdout.trim()
}

/**
 * Bare origin + clone. `dev` carries `shared.txt` plus its own file. Each release
 * branch forks from the ORIGINAL dev and may edit `shared.txt`, so conflicts are
 * genuine rather than fast-forwards.
 */
const makeFixture = async (args: { conflicting?: string[] } = {}): Promise<string> => {
  const conflicting = new Set(args.conflicting ?? [])
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-mergerun-'))

  tmpRoots.push(root)

  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'work')

  await $({ quiet: true })`git init -q --bare ${origin}`
  await $({ quiet: true })`git clone -q ${origin} ${repo}`
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')

  await fs.writeFile(path.join(repo, 'shared.txt'), 'base\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'base')
  await git(repo, 'branch', '-M', 'dev')
  await git(repo, 'push', '-q', '-u', 'origin', 'dev')

  for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
    const branch = `release/v${version}`

    await git(repo, 'switch', '-q', 'dev')
    await git(repo, 'switch', '-qc', branch)

    if (conflicting.has(branch)) {
      await fs.writeFile(path.join(repo, 'shared.txt'), `base\nfrom ${version}\n`)
    } else {
      await fs.writeFile(path.join(repo, `r-${version}.txt`), version)
    }

    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', `release ${version}`)
    await git(repo, 'push', '-q', '-u', 'origin', branch)
  }

  // dev moves forward, editing the same line the conflicting branches touched.
  await git(repo, 'switch', '-q', 'dev')
  await fs.writeFile(path.join(repo, 'shared.txt'), 'base\nfrom dev\n')
  await git(repo, 'commit', '-qam', 'dev work')
  await git(repo, 'push', '-q', 'origin', 'dev')
  await git(repo, 'fetch', '-q', 'origin')

  return repo
}

const RELEASES = ['release/v1.0.0', 'release/v1.1.0', 'release/v1.2.0']

beforeEach(() => {
  process.env.INFRA_KIT_SESSION = `mr${Math.floor(Date.now() % 100000)}`
})

afterAll(async () => {
  await Promise.all(
    tmpRoots.map((root) => {
      return fs.rm(root, { recursive: true, force: true })
    }),
  )
})

describe('planMergeRun', () => {
  it('merges every clean branch and collects a sha for each', async () => {
    const repo = await makeFixture()

    const entries = await withScratchWorktree({ cwd: repo }, (worktree) => {
      return planMergeRun({ cwd: repo, worktreePath: worktree.path, branches: RELEASES })
    })

    expect(
      entries.map((entry) => {
        return entry.status
      }),
    ).toEqual(['merged', 'merged', 'merged'])
    expect(pushableRefs(entries)).toHaveLength(3)

    // Nothing was pushed and no local branch moved — planning is side-effect free
    // on refs, which is what makes the confirm prompt meaningful.
    expect(await git(repo, 'rev-parse', 'origin/release/v1.0.0')).not.toBe(entries[0]?.mergeSha)
  })

  it('tHE CASCADE: a conflict on branch 2 leaves branches 1 and 3 correct', async () => {
    const repo = await makeFixture({ conflicting: ['release/v1.1.0'] })

    const entries = await withScratchWorktree({ cwd: repo }, (worktree) => {
      return planMergeRun({ cwd: repo, worktreePath: worktree.path, branches: RELEASES })
    })

    // Without resetScratchWorktree in the per-branch finally, branch 3 fails with
    // `error: you need to resolve your current index first` — an error it did not
    // cause. That silent misattribution is the failure this ordering exists to stop.
    expect(
      entries.map((entry) => {
        return entry.status
      }),
    ).toEqual(['merged', 'conflict', 'merged'])

    expect(entries[1]?.conflictPaths).toEqual(['shared.txt'])
    expect(entries[1]?.mergeSha).toBeUndefined()
    expect(pushableRefs(entries)).toHaveLength(2)
  })

  it('reports an already-merged branch as up-to-date without checking it out', async () => {
    const repo = await makeFixture()

    await git(repo, 'switch', '-q', 'release/v1.0.0')
    await git(repo, 'merge', 'origin/dev', '--no-edit', '-q')
    await git(repo, 'push', '-q', 'origin', 'release/v1.0.0')
    await git(repo, 'switch', '-q', 'dev')
    await git(repo, 'fetch', '-q', 'origin')

    const entries = await withScratchWorktree({ cwd: repo }, (worktree) => {
      return planMergeRun({ cwd: repo, worktreePath: worktree.path, branches: ['release/v1.0.0'] })
    })

    expect(entries[0]?.status).toBe('up-to-date')
    expect(entries[0]?.mergeSha).toBeUndefined()
  })

  it('reports a strictly-behind branch as fast-forward', async () => {
    const repo = await makeFixture()

    // A branch sitting at dev's PARENT has no commits of its own, so merging dev
    // into it fast-forwards. (`origin/dev^{commit}` would peel to dev itself and
    // classify as up-to-date — correctly, which is how this fixture bug surfaced.)
    await git(repo, 'push', '-q', 'origin', 'origin/dev~1:refs/heads/release/vff')
    await git(repo, 'fetch', '-q', 'origin')

    const entries = await withScratchWorktree({ cwd: repo }, (worktree) => {
      return planMergeRun({ cwd: repo, worktreePath: worktree.path, branches: ['release/vff'] })
    })

    expect(entries[0]?.status).toBe('fast-forward')
    expect(entries[0]?.mergeSha).toBe(await git(repo, 'rev-parse', 'origin/dev'))
  })

  it('fails only the branch that was deleted on origin, not the run', async () => {
    const repo = await makeFixture()

    await git(repo, 'push', '-q', 'origin', '--delete', 'release/v1.1.0')
    await git(repo, 'fetch', '-q', 'origin', '--prune')

    const entries = await withScratchWorktree({ cwd: repo }, (worktree) => {
      return planMergeRun({ cwd: repo, worktreePath: worktree.path, branches: RELEASES })
    })

    // `merge-base --is-ancestor` exits 128 on an unknown ref, so without the
    // rev-parse pre-check this would be a fatal that killed the other two.
    expect(
      entries.map((entry) => {
        return entry.status
      }),
    ).toEqual(['merged', 'error', 'merged'])
  })

  it('writes the on-branch merge subject, not "into HEAD"', async () => {
    const repo = await makeFixture()

    const entries = await withScratchWorktree({ cwd: repo }, (worktree) => {
      return planMergeRun({ cwd: repo, worktreePath: worktree.path, branches: ['release/v1.0.0'] })
    })

    const subject = await git(repo, 'log', '-1', '--format=%s', String(entries[0]?.mergeSha))

    // A detached-HEAD merge defaults to "… into HEAD". The operator's own
    // `git switch <B> && git merge origin/dev` writes the branch name, and
    // reproducibility by a command they already know is why this engine was picked.
    expect(subject).toBe("Merge remote-tracking branch 'origin/dev' into release/v1.0.0")
    expect(subject).not.toContain('into HEAD')
  })

  it('leaves the scratch worktree pristine after a conflict', async () => {
    const repo = await makeFixture({ conflicting: ['release/v1.0.0'] })

    await withScratchWorktree({ cwd: repo }, async (worktree) => {
      await planMergeRun({ cwd: repo, worktreePath: worktree.path, branches: ['release/v1.0.0'] })

      expect(await git(worktree.path, 'status', '--porcelain')).toBe('')
    })
  })
})

describe('reclassify', () => {
  it('drops a branch a teammate merged mid-run instead of letting it abort the push', async () => {
    const repo = await makeFixture()

    const entries = await withScratchWorktree({ cwd: repo }, (worktree) => {
      return planMergeRun({ cwd: repo, worktreePath: worktree.path, branches: RELEASES })
    })

    // A teammate merges dev into release/v1.1.0 themselves and pushes, after we
    // planned. Our collected sha for it is now stale.
    await git(repo, 'switch', '-q', 'release/v1.1.0')
    await git(repo, 'merge', 'origin/dev', '--no-edit', '-q')
    await git(repo, 'push', '-q', 'origin', 'release/v1.1.0')
    await git(repo, 'switch', '-q', 'dev')

    const { kept, nowUpToDate } = await reclassify(repo, pushableRefs(entries))

    // Without this, --atomic would reject the whole push over that one ref and
    // NOTHING would merge — the all-or-nothing guarantee turned against us.
    expect(nowUpToDate).toEqual(['release/v1.1.0'])
    expect(
      kept.map((ref) => {
        return ref.branch
      }),
    ).toEqual(['release/v1.0.0', 'release/v1.2.0'])
  })

  it('keeps every branch when nothing moved', async () => {
    const repo = await makeFixture()

    const entries = await withScratchWorktree({ cwd: repo }, (worktree) => {
      return planMergeRun({ cwd: repo, worktreePath: worktree.path, branches: RELEASES })
    })

    const { kept, nowUpToDate } = await reclassify(repo, pushableRefs(entries))

    expect(nowUpToDate).toEqual([])
    expect(kept).toHaveLength(3)
  })
})

describe('hook failures are distinguished from conflicts, in any locale', () => {
  it('reports hook-failed via git STATE, not prose — the hook never says "hook" and git speaks German', async () => {
    const repo = await makeFixture()

    // A `commit-msg` hook that refuses. The scratch worktree resolves hooks
    // through the shared common dir, so this applies there too. This is the
    // realistic false failure: the scratch checkout starts cold, so a hook
    // shelling into node_modules can fail where the operator's own merge works.
    const hook = path.join(repo, '.git', 'hooks', 'commit-msg')

    await fs.writeFile(hook, '#!/bin/sh\necho "policy violation: message rejected" >&2\nexit 1\n')
    await fs.chmod(hook, 0o700)

    // Ambient locale is NOT English. `classifyMergeFailure` reads git's prose for
    // this one branch, so without the LC_ALL pin on the merge invocation the
    // match silently stops working and this lands in the generic `error` bucket.
    const previous = process.env.LC_ALL

    process.env.LC_ALL = 'de_DE.UTF-8'

    try {
      const entries = await withScratchWorktree({ cwd: repo }, (worktree) => {
        return planMergeRun({ cwd: repo, worktreePath: worktree.path, branches: ['release/v1.0.0'] })
      })

      expect(entries[0]?.status).toBe('hook-failed')
      expect(entries[0]?.mergeSha).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.LC_ALL
      else process.env.LC_ALL = previous
    }
  })
})
