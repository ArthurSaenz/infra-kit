import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchOpenPRsByHead, fetchPRByHead, fetchPRByNumber, getReleasePRsWithInfo } from 'src/integrations/gh'
import type { PRStatus, ReleasePRInfo } from 'src/integrations/gh'
import { commandEcho } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { pickReleaseBranch } from 'src/lib/prompts/release-picker'

import { ghReleaseDeliver } from '../gh-release-deliver'

/**
 * Deliver classifies the release by the PR's BASE branch, never its title, and merges the PR it
 * resolved — by number, after a by-number re-probe — rather than letting `gh pr merge <branch>`
 * pick whatever is open on that head after the confirm (plan: merge-dev-hotfix-guard, Leak 2/3).
 */

const zx = vi.hoisted(() => {
  return { commands: [] as string[] }
})

// A stateless `gh` that lets the RC leg run end to end: `gh pr list --head dev --base main` always
// finds one open PR, so `resolveRcPRNumber` adopts #7 and merges it — which is the observable
// footprint of `ensureRcPRMerged` the hotfix cases assert is absent.
vi.mock('zx', () => {
  const $ = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings
      .map((part, i) => {
        return i < values.length ? part + String(values[i]) : part
      })
      .join('')

    zx.commands.push(command)

    const stdout = command.includes('--head dev --base main --state open')
      ? JSON.stringify([{ number: 7, state: 'OPEN', title: 'stale' }])
      : '[]'

    return Promise.resolve({ stdout, exitCode: 0 })
  })

  return { $: Object.assign($, { quiet: false }) }
})

vi.mock('src/integrations/gh', () => {
  return {
    fetchOpenPRsByHead: vi.fn(),
    fetchPRByHead: vi.fn(),
    fetchPRByNumber: vi.fn(),
    getReleasePRsWithInfo: vi.fn(),
  }
})

vi.mock('src/integrations/jira', () => {
  return { deliverJiraRelease: vi.fn(), loadJiraConfigOptional: vi.fn() }
})

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { deleteLocalBranch: vi.fn(), deleteRemoteBranch: vi.fn(), getProjectRoot: vi.fn() }
})

vi.mock('src/lib/worktrees', () => {
  return { removeReleaseWorktreeIfPresent: vi.fn() }
})

vi.mock('src/lib/prompts/release-picker', () => {
  return { pickReleaseBranch: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const BRANCH = 'release/v1.2.5'

const pr = (overrides: Partial<PRStatus> = {}): PRStatus => {
  return { number: 42, state: 'OPEN', title: 'Release v1.2.5', baseRefName: 'dev', headRefName: BRANCH, ...overrides }
}

const row = (overrides: Partial<ReleasePRInfo> = {}): ReleasePRInfo => {
  return {
    branch: BRANCH,
    number: 42,
    title: 'Release v1.2.5',
    createdAt: '2026-01-01T00:00:00Z',
    baseRefName: 'dev',
    type: 'regular',
    titleMismatch: false,
    dualBase: false,
    ...overrides,
  }
}

const deliver = (version = '1.2.5'): Promise<unknown> => {
  return ghReleaseDeliver({ version, confirmedCommand: true }).catch((e: unknown) => {
    return e
  })
}

const mergeCommands = (): string[] => {
  return zx.commands.filter((command) => {
    return command.startsWith('gh pr merge')
  })
}

const rcCommands = (): string[] => {
  return zx.commands.filter((command) => {
    return command.includes('--head dev --base main')
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  zx.commands = []
  commandEcho.reset()
  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(fetchOpenPRsByHead).mockResolvedValue([pr()])
  vi.mocked(fetchPRByHead).mockResolvedValue(null)
  vi.mocked(fetchPRByNumber).mockResolvedValue(pr())
})

describe('gh-release-deliver — type from base', () => {
  it('a main-based PR titled "Release v1.2.5" is a hotfix: no RC leg, type reported as hotfix', async () => {
    const hotfix = pr({ baseRefName: 'main' })

    vi.mocked(fetchOpenPRsByHead).mockResolvedValue([hotfix])
    vi.mocked(fetchPRByNumber).mockResolvedValue(hotfix)

    const result = await deliver()

    expect(result).toMatchObject({ structuredContent: { type: 'hotfix', success: true } })
    expect(rcCommands()).toEqual([])
    expect(mergeCommands()).toEqual(['gh pr merge 42 --squash --admin --delete-branch'])
  })

  it('a dev-based PR runs the RC leg, and both merges are by number', async () => {
    const result = await deliver()

    expect(result).toMatchObject({ structuredContent: { type: 'regular', success: true } })
    expect(mergeCommands()).toEqual([
      'gh pr merge 42 --squash --admin --delete-branch',
      'gh pr merge 7 --squash --admin',
    ])
    expect(zx.commands.join('\n')).not.toMatch(new RegExp(`gh pr merge ${BRANCH}`))
  })

  it('refuses when the head has two open PRs, before any merge, naming both numbers', async () => {
    vi.mocked(fetchOpenPRsByHead).mockResolvedValue([pr(), pr({ number: 43, baseRefName: 'main' })])

    const error = await deliver()

    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).message).toContain('#42')
    expect((error as OperationError).message).toContain('#43')
    expect(mergeCommands()).toEqual([])
  })

  it('refuses a base outside {dev, main} rather than guessing the type', async () => {
    vi.mocked(fetchOpenPRsByHead).mockResolvedValue([pr({ baseRefName: 'develop' })])

    const error = await deliver()

    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).message).toContain("'develop'")
    expect(mergeCommands()).toEqual([])
  })

  it('resume: no open PR, one MERGED on main → hotfix, merge skipped, RC leg not run', async () => {
    const merged = pr({ state: 'MERGED', baseRefName: 'main' })

    vi.mocked(fetchOpenPRsByHead).mockResolvedValue([])
    vi.mocked(fetchPRByHead).mockResolvedValue(merged)
    vi.mocked(fetchPRByNumber).mockResolvedValue(merged)

    const result = await deliver()

    expect(result).toMatchObject({ structuredContent: { type: 'hotfix', success: true } })
    expect(fetchPRByHead).toHaveBeenCalledWith(BRANCH)
    expect(mergeCommands()).toEqual([])
    expect(rcCommands()).toEqual([])
  })
})

describe('gh-release-deliver — by-number re-probe', () => {
  it.each([
    ['base', pr({ baseRefName: 'main' })],
    ['head', pr({ headRefName: 'release/v9.9.9' })],
  ])('refuses without merging when the re-probed %s disagrees with the resolved target', async (_field, live) => {
    vi.mocked(fetchPRByNumber).mockResolvedValue(live)

    const error = await deliver()

    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).message).toContain('#42')
    expect(fetchPRByNumber).toHaveBeenCalledWith(42)
    expect(mergeCommands()).toEqual([])
  })

  it('still refuses a CLOSED PR without merging', async () => {
    vi.mocked(fetchPRByNumber).mockResolvedValue(pr({ state: 'CLOSED' }))

    const error = await deliver()

    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).message).toContain('closed without merge')
    expect(mergeCommands()).toEqual([])
  })
})

describe('gh-release-deliver — picker path', () => {
  beforeEach(() => {
    vi.mocked(pickReleaseBranch).mockResolvedValue(BRANCH)
  })

  it('refuses a dual-base row before any merge', async () => {
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([row({ baseRefName: 'main', type: 'hotfix', dualBase: true })])

    const error = await deliver('')

    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).message).toContain('both dev and main')
    expect(mergeCommands()).toEqual([])
  })

  it('follows the base on a title/base mismatch: a main-based "Release" row delivers as a hotfix', async () => {
    const hotfix = pr({ baseRefName: 'main' })

    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([
      row({ baseRefName: 'main', type: 'hotfix', titleMismatch: true }),
    ])
    vi.mocked(fetchPRByNumber).mockResolvedValue(hotfix)

    const result = await deliver('')

    expect(result).toMatchObject({ structuredContent: { type: 'hotfix', success: true } })
    expect(rcCommands()).toEqual([])
    expect(mergeCommands()).toEqual(['gh pr merge 42 --squash --admin --delete-branch'])
  })
})
