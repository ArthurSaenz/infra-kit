import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getCurrentBranch, isInsideLinkedWorktree, isWorkingTreeClean } from 'src/lib/git-utils'

// Controllable per-command git output. The mocked `$` dispatches on the command
// text so a single test can make `--absolute-git-dir` and `--git-common-dir`
// return DIFFERENT values — which the shared single-stdout mock cannot express.
const git = vi.hoisted(() => {
  return {
    toplevel: '/repo',
    branch: 'dev',
    status: '',
    absoluteGitDir: '/repo/.git',
    commonDir: '.git',
  }
})

vi.mock('zx', () => {
  const run = (strings: TemplateStringsArray): Promise<{ stdout: string }> => {
    const command = strings.join('')

    if (command.includes('--show-toplevel')) return Promise.resolve({ stdout: `${git.toplevel}\n` })
    if (command.includes('--abbrev-ref HEAD')) return Promise.resolve({ stdout: `${git.branch}\n` })
    if (command.includes('status --porcelain')) return Promise.resolve({ stdout: git.status })
    if (command.includes('--absolute-git-dir')) return Promise.resolve({ stdout: `${git.absoluteGitDir}\n` })
    if (command.includes('--git-common-dir')) return Promise.resolve({ stdout: `${git.commonDir}\n` })

    return Promise.resolve({ stdout: '' })
  }

  // zx's `$` supports both tagged-template form (`$`...``) and an options form
  // (`$({ cwd })`...``) that returns a fresh tagged-template function.
  const $ = vi.fn((first: unknown) => {
    if (!Array.isArray(first)) {
      return (strings: TemplateStringsArray) => {
        return run(strings)
      }
    }

    return run(first as unknown as TemplateStringsArray)
  })

  return { $ }
})

describe('getCurrentBranch', () => {
  beforeEach(() => {
    git.branch = 'dev'
  })

  it('returns the trimmed branch name', async () => {
    git.branch = 'release/v1.2.3'

    await expect(getCurrentBranch()).resolves.toBe('release/v1.2.3')
  })
})

describe('isWorkingTreeClean', () => {
  it('returns true when porcelain output is empty', async () => {
    git.status = ''

    await expect(isWorkingTreeClean()).resolves.toBe(true)
  })

  it('returns true when porcelain output is whitespace only', async () => {
    git.status = '\n'

    await expect(isWorkingTreeClean()).resolves.toBe(true)
  })

  it('returns false when there are changes', async () => {
    git.status = ' M src/foo.ts\n?? new.ts\n'

    await expect(isWorkingTreeClean()).resolves.toBe(false)
  })
})

describe('isInsideLinkedWorktree', () => {
  beforeEach(() => {
    git.toplevel = '/repo'
  })

  it('returns false in the main checkout (git dir resolves to the common dir)', async () => {
    git.absoluteGitDir = '/repo/.git'
    git.commonDir = '.git'

    await expect(isInsideLinkedWorktree()).resolves.toBe(false)
  })

  it('returns true in a linked worktree (git dir under .git/worktrees, differs from common dir)', async () => {
    git.absoluteGitDir = '/repo/.git/worktrees/release-v1.2.3'
    git.commonDir = '/repo/.git'

    await expect(isInsideLinkedWorktree()).resolves.toBe(true)
  })
})
