import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  deleteLocalBranch,
  deleteRemoteBranch,
  getCurrentBranch,
  isInsideLinkedWorktree,
  isWorkingTreeClean,
} from 'src/lib/git-utils'

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
    branchList: '',
    lsRemote: '',
    lsRemoteThrows: false,
    localDeleteThrows: false,
    remoteDeleteThrows: false,
    calls: [] as string[],
  }
})

vi.mock('zx', () => {
  const run = (strings: TemplateStringsArray): Promise<{ stdout: string }> => {
    const command = strings.join('')

    git.calls.push(command)

    if (command.includes('--show-toplevel')) return Promise.resolve({ stdout: `${git.toplevel}\n` })
    if (command.includes('--abbrev-ref HEAD')) return Promise.resolve({ stdout: `${git.branch}\n` })
    if (command.includes('status --porcelain')) return Promise.resolve({ stdout: git.status })
    if (command.includes('--absolute-git-dir')) return Promise.resolve({ stdout: `${git.absoluteGitDir}\n` })
    if (command.includes('--git-common-dir')) return Promise.resolve({ stdout: `${git.commonDir}\n` })
    if (command.includes('branch --list')) return Promise.resolve({ stdout: git.branchList })
    if (command.includes('branch -D')) {
      return git.localDeleteThrows
        ? Promise.reject(new Error('branch checked out in another worktree'))
        : Promise.resolve({ stdout: '' })
    }
    if (command.includes('ls-remote --heads')) {
      return git.lsRemoteThrows
        ? Promise.reject(new Error('could not read from remote repository'))
        : Promise.resolve({ stdout: git.lsRemote })
    }
    if (command.includes('push origin --delete')) {
      return git.remoteDeleteThrows
        ? Promise.reject(new Error('remote ref does not exist'))
        : Promise.resolve({ stdout: '' })
    }

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

const ranLocalDelete = (): boolean => {
  return git.calls.some((c) => {
    return c.includes('branch -D')
  })
}
const ranRemoteDelete = (): boolean => {
  return git.calls.some((c) => {
    return c.includes('push origin --delete')
  })
}

describe('deleteLocalBranch', () => {
  beforeEach(() => {
    git.branch = 'dev'
    git.branchList = ''
    git.localDeleteThrows = false
    git.calls = []
  })

  it('force-deletes the branch when it exists and is not current', async () => {
    git.branchList = '  release/v1.2.3\n'

    await deleteLocalBranch('release/v1.2.3')

    expect(ranLocalDelete()).toBe(true)
  })

  it('is a no-op when the branch does not exist locally', async () => {
    git.branchList = ''

    await deleteLocalBranch('release/v1.2.3')

    expect(ranLocalDelete()).toBe(false)
  })

  it('is a no-op when the branch is the current checkout', async () => {
    git.branch = 'release/v1.2.3'
    git.branchList = '* release/v1.2.3\n'

    await deleteLocalBranch('release/v1.2.3')

    expect(ranLocalDelete()).toBe(false)
  })

  it('propagates when the delete itself fails (e.g. checked out in another worktree)', async () => {
    git.branchList = '  release/v1.2.3\n'
    git.localDeleteThrows = true

    await expect(deleteLocalBranch('release/v1.2.3')).rejects.toThrow()
  })
})

describe('deleteRemoteBranch', () => {
  beforeEach(() => {
    git.lsRemote = ''
    git.lsRemoteThrows = false
    git.remoteDeleteThrows = false
    git.calls = []
  })

  it('deletes the remote branch when ls-remote finds it', async () => {
    git.lsRemote = 'abc123\trefs/heads/release/v1.2.3\n'

    await deleteRemoteBranch('release/v1.2.3')

    expect(ranRemoteDelete()).toBe(true)
  })

  it('is a no-op when the branch does not exist on the remote', async () => {
    git.lsRemote = ''

    await deleteRemoteBranch('release/v1.2.3')

    expect(ranRemoteDelete()).toBe(false)
  })

  it('propagates a network/auth failure instead of treating it as "branch absent"', async () => {
    git.lsRemoteThrows = true

    await expect(deleteRemoteBranch('release/v1.2.3')).rejects.toThrow()
    expect(ranRemoteDelete()).toBe(false)
  })

  it('propagates when the remote delete itself fails', async () => {
    git.lsRemote = 'abc123\trefs/heads/release/v1.2.3\n'
    git.remoteDeleteThrows = true

    await expect(deleteRemoteBranch('release/v1.2.3')).rejects.toThrow()
  })
})
