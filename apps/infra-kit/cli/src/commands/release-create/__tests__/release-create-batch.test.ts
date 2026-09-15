import select from '@inquirer/select'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { commandEcho } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { mcpMode } from 'src/lib/mcp-mode'

import { releaseCreate } from '../release-create'

const mocks = vi.hoisted(() => {
  return {
    loadJiraConfig: vi.fn(),
    assertManagementContext: vi.fn(),
    assertBaseBranchSwitchable: vi.fn(),
    assertCleanCheckout: vi.fn(),
    prepareGitForRelease: vi.fn(),
    createSingleRelease: vi.fn(),
  }
})

vi.mock('src/integrations/jira', () => {
  return { loadJiraConfig: mocks.loadJiraConfig }
})

vi.mock('src/lib/git-guard', () => {
  return {
    assertManagementContext: mocks.assertManagementContext,
    assertBaseBranchSwitchable: mocks.assertBaseBranchSwitchable,
    assertCleanCheckout: mocks.assertCleanCheckout,
  }
})

vi.mock('src/lib/release-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/release-utils')>()

  return {
    ...actual,
    prepareGitForRelease: mocks.prepareGitForRelease,
    createSingleRelease: mocks.createSingleRelease,
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

// The wizard's first prompt. Automocked so a headless refusal that FAILED to fire would surface as a
// mock call, not as an inquirer prompt hanging on a stdin that is not there.
vi.mock('@inquirer/select')

const confirmMock = vi.hoisted(() => {
  return vi.fn()
})

vi.mock('src/lib/command-echo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/command-echo')>()

  return { ...actual, confirmOrExit: confirmMock }
})

const releases = [
  { version: '1.2.3', type: 'regular' as const },
  { version: '1.3.0', type: 'regular' as const },
]

const dirtyTree = () => {
  return new OperationError(undefined, {
    operation: 'create release',
    remediation: 'commit or stash your changes (`git stash -u`), then retry',
    stderrExcerpt: 'working tree has uncommitted changes: M src/foo.ts',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadJiraConfig.mockResolvedValue({ baseUrl: 'https://jira', token: 't', email: 'e', projectId: 1 })
  mocks.assertManagementContext.mockResolvedValue(undefined)
  mocks.assertBaseBranchSwitchable.mockResolvedValue(undefined)
  mocks.assertCleanCheckout.mockResolvedValue(undefined)
  confirmMock.mockResolvedValue(undefined)
})

describe('releaseCreate — batch behaviour around the per-entry guard', () => {
  beforeEach(() => {
    mocks.prepareGitForRelease.mockResolvedValue('a'.repeat(40))
    mocks.createSingleRelease.mockImplementation((args: { id: { raw: string } }) => {
      return Promise.resolve({
        version: args.id.raw,
        type: 'regular',
        branchName: `release/v${args.id.raw}`,
        prUrl: 'https://gh/pr/1',
        jiraVersionUrl: 'https://jira/v',
      })
    })
  })

  it('refuses before the wizard and before Jira is contacted when the checkout is unusable', async () => {
    mocks.assertManagementContext.mockRejectedValue(dirtyTree())

    await expect(releaseCreate({ releases, confirmedCommand: true })).rejects.toThrow(/uncommitted/)
    expect(mocks.loadJiraConfig).not.toHaveBeenCalled()
  })

  it('checks the base branch is switchable before any release is created', async () => {
    mocks.assertBaseBranchSwitchable.mockRejectedValue(new Error('held by a worktree'))

    await expect(releaseCreate({ releases, confirmedCommand: true })).rejects.toThrow(/worktree/)
    expect(mocks.createSingleRelease).not.toHaveBeenCalled()
    expect(confirmMock).not.toHaveBeenCalled()
  })

  // Asserted by invocation ORDER, not just by "did it run". The base check has to sit after the
  // entries exist (that is the earliest point `base` is knowable) and before the operator is asked
  // to confirm — otherwise a refusal arrives after they have already approved the batch. A future
  // refactor that hoists the confirm above the guard would still satisfy a presence-only test.
  it('asks the operator to confirm only after the base branch has been cleared', async () => {
    await releaseCreate({ releases, confirmedCommand: true })

    const guardOrder = mocks.assertBaseBranchSwitchable.mock.invocationCallOrder[0] as number
    const confirmOrder = confirmMock.mock.invocationCallOrder[0] as number
    const mutationOrder = mocks.prepareGitForRelease.mock.invocationCallOrder[0] as number

    expect(guardOrder).toBeLessThan(confirmOrder)
    expect(confirmOrder).toBeLessThan(mutationOrder)
  })

  // Homogeneity is what makes a SINGLE base branch knowable, so it has to settle first; a mixed
  // batch must be rejected without the base check ever being asked an unanswerable question.
  it('rejects a mixed-type batch before reaching the base-branch check', async () => {
    const mixed = [
      { version: '1.2.3', type: 'regular' as const },
      { version: '1.2.4', type: 'hotfix' as const },
    ]

    await expect(releaseCreate({ releases: mixed, confirmedCommand: true })).rejects.toThrow(/mixed/)
    expect(mocks.assertBaseBranchSwitchable).not.toHaveBeenCalled()
  })

  it('re-checks the working tree once per entry', async () => {
    await releaseCreate({ releases, confirmedCommand: true })

    expect(mocks.assertCleanCheckout).toHaveBeenCalledTimes(2)
  })

  // The guard sits INSIDE executeOne's try on purpose. A tree dirtied between entries must be
  // recorded as that entry's failure, not thrown past the loop — otherwise the operator loses the
  // PR URLs of every release that already succeeded, which is the one thing they cannot recover.
  it('records a mid-batch refusal as that entry failing and still reports the successes', async () => {
    mocks.assertCleanCheckout.mockResolvedValueOnce(undefined).mockRejectedValueOnce(dirtyTree())

    const result = await releaseCreate({ releases, confirmedCommand: true })

    expect(result.structuredContent.successCount).toBe(1)
    expect(result.structuredContent.failureCount).toBe(1)
    expect(result.structuredContent.createdBranches).toEqual(['release/v1.2.3'])
  })

  // The refusal is re-wrapped by executeOne, and OperationError does not expose `.stderr`. Without
  // the cause-walk this assertion sees only the generic outer remediation, and every new refusal
  // this command can raise would reach an MCP client as an opaque string.
  it('carries the offending paths into the machine-readable failure record', async () => {
    mocks.assertCleanCheckout.mockRejectedValue(dirtyTree())

    const result = await releaseCreate({ releases, confirmedCommand: true })

    expect(result.structuredContent.failedReleases[0]?.error).toContain('M src/foo.ts')
  })
})

describe('releaseCreate — headless over MCP, no releases', () => {
  beforeEach(() => {
    mcpMode.enabled = true
  })

  afterEach(() => {
    mcpMode.enabled = false
    vi.restoreAllMocks()
  })

  // Reachable only on a round 2 whose token was minted over `{}`: the MCP seam offers a form first,
  // and a client that cannot render one sees a gate with empty `resolvedArgs`. Confirming THAT must
  // land on a refusal that names the field, never on the wizard writing into the JSON-RPC transport.
  it('refuses with a remediation naming "releases" before the wizard has a side effect', async () => {
    const setInteractive = vi.spyOn(commandEcho, 'setInteractive')

    const outcome = releaseCreate({ confirmedCommand: true })

    await expect(outcome).rejects.toBeInstanceOf(OperationError)
    await expect(outcome).rejects.toMatchObject({ remediation: expect.stringContaining('"releases"') })
    expect(vi.mocked(select)).not.toHaveBeenCalled()
    expect(setInteractive).not.toHaveBeenCalled()
    expect(mocks.prepareGitForRelease).not.toHaveBeenCalled()
  })

  // The form's `toArgs` lets a name the rule rejects through on purpose, so the refusal that names the
  // rule comes from here — and it has to arrive before anything has touched git.
  it('refuses a form-shaped bad name with the kebab-case remediation before any mutation', async () => {
    const outcome = releaseCreate({
      releases: [{ name: 'Checkout Redesign', type: 'regular' }],
      confirmedCommand: true,
    })

    await expect(outcome).rejects.toBeInstanceOf(OperationError)
    await expect(outcome).rejects.toMatchObject({ remediation: expect.stringContaining('use a kebab-case name') })
    expect(mocks.prepareGitForRelease).not.toHaveBeenCalled()
  })
})
