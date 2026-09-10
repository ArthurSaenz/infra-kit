import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { removeJiraVersion } from 'src/integrations/jira/remove-version'
import { commandEcho } from 'src/lib/command-echo'
import { branchExists, deleteLocalBranch, deleteRemoteBranch, getCurrentBranch } from 'src/lib/git-utils'
import { isMcpMode } from 'src/lib/mcp-mode'

import { releaseRemove } from '../release-remove'
import { BASE_BRANCH, BRANCH, LABEL, installDefaults } from './release-remove-mocks'

/**
 * @fileoverview
 * PM-1, the fail-open: "It said it removed it."
 *
 * `deleteLocalBranch` runs `git branch -d/-D`, and git silently refuses to delete the branch that is
 * currently checked out. The helper does not read that back, so an operator standing ON the release
 * branch used to get a full success report for a branch that is still there. Two things convert that
 * into a fail-closed, and this suite pins both:
 *
 *   (a) `git switch <base>` is issued BEFORE the delete when `getCurrentBranch()` is the target.
 *       Ordering is the whole point — a switch issued after the delete fixes nothing.
 *   (b) the delete is VERIFIED with `branchExists`, and a branch that survives makes the command
 *       THROW.
 *
 * The false-success named verbatim: `localBranch: "deleted"` and exit 0 for a branch that is still
 * checked out and still present — after the worktree, the PR and the remote branch are already gone,
 * so the operator has no reason to look again.
 *
 * Mocked: git, gh, cmux, Jira, and zx’s `$` — the switch is a raw `$` call, so recording the
 * command line is the only way to observe it. Real: the step control flow and the residue report.
 */

const state = vi.hoisted(() => {
  return { order: [] as string[] }
})

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()
  // Imported INSIDE the factory: this file’s top-level bindings are still in their temporal dead zone.
  const { zxCommandMock } = await import('src/lib/git-utils/__tests__/zx-command-mock')

  return {
    ...actual,
    $: zxCommandMock((command) => {
      if (command.includes('git switch')) state.order.push(`switch:${command}`)

      return { stdout: '' }
    }),
  }
})

vi.mock('src/lib/git-guard', () => {
  return { assertBaseBranchSwitchable: vi.fn(), assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return {
    branchExists: vi.fn(),
    deleteLocalBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    getCurrentBranch: vi.fn(),
    getCurrentWorktrees: vi.fn(),
    getProjectRoot: vi.fn(),
    lsRemoteHead: vi.fn(),
    revParseVerify: vi.fn(),
  }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/lib/mcp-mode', () => {
  return { isMcpMode: vi.fn() }
})

vi.mock('src/lib/prompts/release-picker', () => {
  return { pickReleaseBranch: vi.fn() }
})

// LEAF, not the `src/lib/worktrees` barrel — `release-remove.ts:49` imports it from here, and a
// barrel mock would leave the real `git worktree remove` running.
vi.mock('src/lib/worktrees/remove-release-worktree', () => {
  return { removeReleaseWorktreeIfPresent: vi.fn() }
})

vi.mock('src/integrations/cmux', () => {
  return { listCmuxWorkspacesByCwd: vi.fn(), realpathForCmuxCwd: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

// LEAF, for the same reason (`release-remove.ts:11`): mocking only the barrel let the REAL
// `fetchPRByHead` run `gh pr list` during an earlier draft of this suite.
vi.mock('src/integrations/gh/pr-status', () => {
  return { fetchPRByHead: vi.fn() }
})

vi.mock('src/integrations/ide', () => {
  return { removeIdeWorktreeFolders: vi.fn() }
})

// Spread, so `buildJiraVersionUrl` stays real and the URL in the result is derived exactly as in
// production; only the two lookup calls are replaced.
vi.mock('src/integrations/jira', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/jira')>()

  return { ...actual, findVersionByName: vi.fn(), loadJiraConfigOptional: vi.fn() }
})

// LEAF (`release-remove.ts:17`): these two are the Jira calls that reach the network.
vi.mock('src/integrations/jira/remove-version', () => {
  return { getVersionRelatedIssueCounts: vi.fn(), removeJiraVersion: vi.fn() }
})

// `resolveReleaseBranch`, `getBaseBranch` and `detectReleaseType` stay REAL so the version→branch
// and PR-title→base-branch derivations are exercised as in production.
vi.mock('src/lib/release-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/release-utils')>()

  return { ...actual, getJiraDescriptions: vi.fn() }
})

vi.mock('@inquirer/confirm', () => {
  return { default: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }
})

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  state.order = []

  installDefaults()
  vi.mocked(isMcpMode).mockReturnValue(false)
  vi.mocked(confirm).mockResolvedValue(true)

  vi.mocked(deleteLocalBranch).mockImplementation(async () => {
    state.order.push('delete')
  })
})

describe('release remove — standing on the branch being deleted', () => {
  it('switches to the base branch BEFORE deleting, not after', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue(BRANCH)

    await releaseRemove({ confirmedCommand: true, version: LABEL })

    // A single ordered array, so a failure prints the actual sequence rather than two opaque counters.
    expect(state.order).toEqual([`switch:git switch ${BASE_BRANCH}`, 'delete'])
  })

  it('does not switch when HEAD is already elsewhere', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue(BASE_BRANCH)

    await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(state.order).toEqual(['delete'])
  })
})

describe('release remove — the delete is verified, not assumed', () => {
  it('throws when the branch still exists afterwards, instead of reporting localBranch: "deleted"', async () => {
    vi.mocked(branchExists).mockResolvedValue(true)

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain(`${BRANCH} still exists after the delete`)
    expect((error as Error).message).toContain(`git branch -D ${BRANCH}`)
    expect((error as Error).message).toContain('step 4 of 6 (delete the local branch)')
  })

  it('leaves the remote branch and the fix version alone when the local delete did not take', async () => {
    vi.mocked(branchExists).mockResolvedValue(true)

    await expect(releaseRemove({ confirmedCommand: true, version: LABEL })).rejects.toThrow()

    expect(deleteRemoteBranch).not.toHaveBeenCalled()
    expect(removeJiraVersion).not.toHaveBeenCalled()
  })
})
