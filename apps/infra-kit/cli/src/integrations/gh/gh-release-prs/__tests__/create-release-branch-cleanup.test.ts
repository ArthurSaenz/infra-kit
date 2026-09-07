import { beforeEach, describe, expect, it, vi } from 'vitest'

import { zxCommandMock } from 'src/lib/git-utils/__tests__/zx-command-mock'

import { createReleaseBranch } from '../gh-release-prs'

const BASE_SHA = 'a'.repeat(40)

const state = vi.hoisted(() => {
  return {
    commands: [] as string[],
    /** Substring -> the result that command should produce. First match wins. */
    overrides: [] as { match: string; stdout?: string; exitCode?: number; throws?: boolean }[],
    status: [] as string[],
    head: 'a'.repeat(40),
  }
})

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()

  return {
    ...actual,
    $: zxCommandMock((command) => {
      state.commands.push(command)

      const override = state.overrides.find((entry) => {
        return command.includes(entry.match)
      })

      if (override) {
        return override.throws ? { throws: new Error(`command failed: ${command}`) } : override
      }

      if (command.includes('git status --porcelain')) return { stdout: state.status.join('\n') }
      if (command.includes('git rev-parse HEAD')) return { stdout: state.head }
      if (command.includes('gh pr create')) return { stdout: 'https://gh/pr/1' }

      return {}
    }),
  }
})

const loggerMock = vi.hoisted(() => {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: loggerMock }
})

const loggedMessages = (): string => {
  return loggerMock.error.mock.calls
    .map((call) => {
      return call.map(String).join(' ')
    })
    .join('\n')
}

const id = { kind: 'version', semver: { major: 1, minor: 2, patch: 3 }, raw: '1.2.3' } as const
const BRANCH = 'release/v1.2.3'

const run = () => {
  return createReleaseBranch({ id, jiraVersionUrl: 'https://jira/v', type: 'regular', baseSha: BASE_SHA })
}

const indexOfCommand = (needle: string): number => {
  return state.commands.findIndex((command) => {
    return command.includes(needle)
  })
}

describe('createReleaseBranch — ordering, guards and cleanup', () => {
  beforeEach(() => {
    state.commands = []
    state.overrides = []
    state.status = []
    state.head = BASE_SHA
    loggerMock.error.mockClear()
  })

  // Pushing before committing published a branch with zero commits: any later failure left a
  // remote ref that could not even take a PR ("no commits between base and head"). Committing
  // first means one push, of a branch that is already complete.
  it('commits before it pushes, and pushes exactly once', async () => {
    await run()

    expect(indexOfCommand('git checkout -b')).toBeLessThan(indexOfCommand('git commit'))
    expect(indexOfCommand('git commit')).toBeLessThan(indexOfCommand('git push'))
    expect(indexOfCommand('git push')).toBeLessThan(indexOfCommand('gh pr create'))
    expect(
      state.commands.filter((command) => {
        return command.includes('git push')
      }),
    ).toHaveLength(1)
  })

  // The caller already fetched and pulled the base; repeating it here only widened the window in
  // which the checkout could change underneath the branch cut.
  it('does not re-switch or re-pull the base before cutting', async () => {
    await run()

    const beforeCut = state.commands.slice(0, indexOfCommand('git checkout -b'))

    expect(
      beforeCut.filter((command) => {
        return command.includes('git pull')
      }),
    ).toHaveLength(0)
    expect(
      beforeCut.filter((command) => {
        return command.startsWith('git switch')
      }),
    ).toHaveLength(0)
  })

  it('refuses on a dirty tree without cutting a branch', async () => {
    state.status = ['M src/foo.ts']

    await expect(run()).rejects.toThrow(/uncommitted/)
    expect(indexOfCommand('git checkout -b')).toBe(-1)
  })

  // The caller's clean-tree check is separated from this point by a Jira round trip, so the
  // checkout can move between the two. This is the assertion that catches it.
  it('refuses when HEAD has moved off the verified base SHA', async () => {
    state.head = 'b'.repeat(40)

    await expect(run()).rejects.toThrow(/HEAD/)
    expect(indexOfCommand('git checkout -b')).toBe(-1)
  })

  it('returns to the base branch on the success path', async () => {
    await run()

    expect(state.commands.at(-1)).toBe(`git switch dev`)
  })

  // The old code put this switch on the success path only, so a failure left the operator
  // standing on the half-made release branch.
  it('returns to the base branch on the failure path too', async () => {
    state.overrides = [{ match: 'gh pr create', throws: true }]

    await expect(run()).rejects.toThrow()
    expect(state.commands.at(-1)).toBe(`git switch dev`)
  })

  it('deletes the local branch when the push never reached the remote', async () => {
    state.overrides = [{ match: 'git push', throws: true }]

    await expect(run()).rejects.toThrow()
    expect(indexOfCommand(`git branch -D ${BRANCH}`)).toBeGreaterThan(-1)
  })

  // A push the remote accepted whose transport then died still exits non-zero. Deleting there
  // would destroy the operator's only handle on a half-made release.
  it('keeps the branch when the remote already has the ref', async () => {
    state.overrides = [
      { match: 'gh pr create', throws: true },
      { match: 'git ls-remote', stdout: `${'c'.repeat(40)}\trefs/heads/${BRANCH}` },
    ]

    await expect(run()).rejects.toThrow()
    expect(indexOfCommand('git branch -D')).toBe(-1)
  })

  // The probe's most likely failure is the same network or auth problem that failed the push, so
  // an unanswerable probe must not be read as "the branch is absent".
  it('keeps the branch when the remote probe cannot answer', async () => {
    state.overrides = [
      { match: 'gh pr create', throws: true },
      { match: 'git ls-remote', exitCode: 128 },
    ]

    await expect(run()).rejects.toThrow()
    expect(indexOfCommand('git branch -D')).toBe(-1)
  })

  // git refuses to delete the branch you are standing on, and under `nothrow` that refusal is
  // silent — so a cleanup whose `git switch` failed would report success while doing nothing, and
  // the operator would only find out when the retry died on "branch already exists".
  it('reports a local delete that did not take', async () => {
    state.overrides = [
      { match: 'git push', throws: true },
      { match: 'git branch -D', exitCode: 1 },
    ]

    await expect(run()).rejects.toThrow()
    expect(loggedMessages()).toContain(`could not remove the local branch ${BRANCH}`)
  })

  it('distinguishes an unreachable remote from a branch that is really on origin', async () => {
    state.overrides = [
      { match: 'gh pr create', throws: true },
      { match: 'git ls-remote', exitCode: 128 },
    ]

    await expect(run()).rejects.toThrow()
    expect(loggedMessages()).toContain('could not reach origin')
  })

  // The cleanup region opens only after `checkout -b` resolves. A branch that already existed is
  // not one this command created, and force-deleting it would destroy the operator's commits.
  it('never rolls back when the branch already existed', async () => {
    state.overrides = [{ match: 'git checkout -b', throws: true }]

    await expect(run()).rejects.toThrow()
    expect(indexOfCommand('git branch -D')).toBe(-1)
    expect(indexOfCommand('git ls-remote')).toBe(-1)
  })
})
