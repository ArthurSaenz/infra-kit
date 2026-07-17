import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getCurrentWorktrees, listWorktrees } from 'src/lib/git-utils'

const worktreeList = vi.hoisted(() => {
  return { stdout: '' }
})

// zx's `$` is called two ways here: `$({ cwd })` returns a tagged-template
// function. Mirror that shape — `$(...)` returns a tag fn that resolves to the
// canned porcelain stdout.
vi.mock('zx', () => {
  return {
    $: vi.fn(() => {
      return () => {
        return Promise.resolve(worktreeList)
      }
    }),
  }
})

/**
 * Build one `git worktree list --porcelain` record. Attribute lines beyond the
 * opening `worktree <path>` are passed in verbatim (e.g. `branch refs/heads/x`,
 * `bare`, `detached`, `locked`, `prunable reason`).
 */
const record = (worktreePath: string, ...attrs: string[]): string => {
  return [`worktree ${worktreePath}`, ...attrs].join('\n')
}

const branchRecord = (branch: string): string => {
  return record(`/repos/project-worktrees/${branch}`, 'HEAD abc1234', `branch refs/heads/${branch}`)
}

describe('getCurrentWorktrees', () => {
  beforeEach(() => {
    worktreeList.stdout = [
      record('/repos/project', 'HEAD abc1234', 'branch refs/heads/main'),
      branchRecord('release/v1.18.22'),
      branchRecord('release/checkout-redesign'),
      branchRecord('release/Bad_Name'),
      branchRecord('feature/login-page'),
      record('/repos/project-bare', 'bare'),
      '',
    ].join('\n\n')
  })

  it('returns versioned AND named release worktrees for type release', async () => {
    await expect(getCurrentWorktrees('release')).resolves.toEqual(['release/v1.18.22', 'release/checkout-redesign'])
  })

  it('excludes junk release branches and non-release branches', async () => {
    const branches = await getCurrentWorktrees('release')

    expect(branches).not.toContain('release/Bad_Name')
    expect(branches).not.toContain('feature/login-page')
    expect(branches).not.toContain('main')
  })

  it('returns feature worktrees for type feature', async () => {
    await expect(getCurrentWorktrees('feature')).resolves.toEqual(['feature/login-page'])
  })
})

describe('listWorktrees', () => {
  it('parses the main checkout, strips refs/heads/ from the branch', async () => {
    worktreeList.stdout = record('/repos/project', 'HEAD abc1234', 'branch refs/heads/main')

    await expect(listWorktrees('/repos/project')).resolves.toEqual([
      { path: '/repos/project', branch: 'main', detached: false, bare: false, prunable: false, locked: false },
    ])
  })

  it('marks a detached worktree with branch null', async () => {
    worktreeList.stdout = record('/repos/project-worktrees/detached', 'HEAD abc1234', 'detached')

    const [entry] = await listWorktrees('/repos/project')

    expect(entry).toMatchObject({ path: '/repos/project-worktrees/detached', branch: null, detached: true })
  })

  it('marks a bare worktree', async () => {
    worktreeList.stdout = record('/repos/project.git', 'bare')

    const [entry] = await listWorktrees('/repos/project')

    expect(entry).toMatchObject({ path: '/repos/project.git', bare: true, branch: null })
  })

  it('marks a prunable worktree (with or without a reason)', async () => {
    worktreeList.stdout = record(
      '/repos/gone',
      'HEAD abc1234',
      'branch refs/heads/x',
      'prunable gitdir file points to non-existent location',
    )

    const [entry] = await listWorktrees('/repos/project')

    expect(entry).toMatchObject({ path: '/repos/gone', prunable: true, branch: 'x' })
  })

  it('marks a locked worktree', async () => {
    worktreeList.stdout = record('/repos/locked', 'HEAD abc1234', 'branch refs/heads/x', 'locked')

    const [entry] = await listWorktrees('/repos/project')

    expect(entry).toMatchObject({ path: '/repos/locked', locked: true })
  })

  it('preserves a path containing spaces', async () => {
    worktreeList.stdout = record('/repos/my project/wt', 'HEAD abc1234', 'branch refs/heads/x')

    const [entry] = await listWorktrees('/repos/project')

    expect(entry?.path).toBe('/repos/my project/wt')
  })

  it('parses multiple records separated by blank lines', async () => {
    worktreeList.stdout = [
      record('/repos/project', 'HEAD abc1234', 'branch refs/heads/main'),
      record('/repos/project-worktrees/feature/x', 'HEAD def5678', 'branch refs/heads/feature/x'),
    ].join('\n\n')

    const entries = await listWorktrees('/repos/project')

    expect(entries).toHaveLength(2)
    expect(
      entries.map((e) => {
        return e.branch
      }),
    ).toEqual(['main', 'feature/x'])
  })
})
