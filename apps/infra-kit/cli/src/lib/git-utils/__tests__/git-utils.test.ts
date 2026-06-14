import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getCurrentWorktrees } from 'src/lib/git-utils'

const worktreeList = vi.hoisted(() => {
  return { stdout: '' }
})

vi.mock('zx', () => {
  return {
    $: vi.fn(() => {
      return Promise.resolve(worktreeList)
    }),
  }
})

const asWorktreeLine = (branch: string): string => {
  return `/repos/project-worktrees/${branch}  abc1234 [${branch}]`
}

describe('getCurrentWorktrees', () => {
  beforeEach(() => {
    worktreeList.stdout = [
      asWorktreeLine('main'),
      asWorktreeLine('release/v1.18.22'),
      asWorktreeLine('release/n/checkout-redesign'),
      asWorktreeLine('release/garbage'),
      asWorktreeLine('feature/login-page'),
      '/repos/project  abc1234 (bare)',
      '',
    ].join('\n')
  })

  it('returns versioned AND named release worktrees for type release', async () => {
    await expect(getCurrentWorktrees('release')).resolves.toEqual(['release/v1.18.22', 'release/n/checkout-redesign'])
  })

  it('excludes junk release branches and non-release branches', async () => {
    const branches = await getCurrentWorktrees('release')

    expect(branches).not.toContain('release/garbage')
    expect(branches).not.toContain('feature/login-page')
    expect(branches).not.toContain('main')
  })

  it('returns feature worktrees for type feature', async () => {
    await expect(getCurrentWorktrees('feature')).resolves.toEqual(['feature/login-page'])
  })
})
