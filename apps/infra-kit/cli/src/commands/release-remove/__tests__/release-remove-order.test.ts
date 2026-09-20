import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { removeIdeWorktreeFolders } from 'src/integrations/ide'
import { removeJiraVersion } from 'src/integrations/jira/remove-version'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { deleteLocalBranch, deleteRemoteBranch } from 'src/lib/git-utils'
import { removeReleaseWorktreeIfPresent } from 'src/lib/worktrees/remove-release-worktree'

import { releaseRemove } from '../release-remove'
import { BRANCH, JIRA_NAME, LABEL, LOCAL_TIP, installDefaults } from './release-remove-mocks'

/**
 * @fileoverview
 * D4 — step order, and what an abort is allowed to leave behind.
 *
 * The six steps run in ASCENDING irreversibility: worktree, ide-folders, pr, local-branch,
 * remote-branch, jira. That ordering is the entire safety argument — a worktree is recreated by
 * `worktrees add`, a closed PR is reopened in the UI, a branch is restored from the captured tip
 * sha, and the Jira fix version is the one thing that is gone for good. Reorder the list and an
 * abort stops leaving the most repairable residue, with nothing else in the codebase objecting.
 *
 * MECHANISM, stated because "assert call ordering across five modules" is not implementable as
 * written: every mocked collaborator pushes its step id into ONE shared `order` array, asserted with
 * `toEqual`. `mock.invocationCallOrder` is deliberately not used — it compares opaque global
 * counters and a failure prints two integers instead of the sequence that actually ran.
 *
 * Two false-successes are pinned besides the order:
 *   - a failure at step 5 that still reached step 6, i.e. an unrecoverable Jira delete performed on
 *     a teardown nobody inspected. The residue report must enumerate the four completed steps, name
 *     the surviving fix version, and carry the local tip sha — the only handle that restores the
 *     branch once steps 4-5 have run.
 *   - a THROWING editor cleanup that aborted the run. Step 2 is the single exemption from
 *     abort-on-first-error precisely because it carries no state into steps 3-6; a cosmetic Cursor
 *     write failure must not strand a teardown with the worktree gone, the PR open, the branch live
 *     and the fix version live.
 *
 * Mocked: every step collaborator plus zx. Real: `runStep`/`tryStep`, the residue builder, and the
 * result projection.
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
      // The PR close is a raw `$` call, so the shell is the only place step 3 is observable.
      if (command.includes('gh pr close')) state.order.push('pr')

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

vi.mock('src/lib/prompts/release-picker', () => {
  return { pickReleaseBranch: vi.fn() }
})

// LEAF, not the `src/lib/worktrees` barrel — `release-remove.ts:49` imports it from here, and a
// barrel mock would leave the real `git worktree remove` running.
vi.mock('src/lib/worktrees/remove-release-worktree', () => {
  return { removeReleaseWorktreeIfPresent: vi.fn() }
})

vi.mock('src/integrations/orca', () => {
  return { listOrcaTerminals: vi.fn(), orcaCallerInsideTargets: vi.fn() }
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
  agentMode.source = null
  vi.mocked(confirm).mockResolvedValue(true)

  vi.mocked(removeReleaseWorktreeIfPresent).mockImplementation(async () => {
    state.order.push('worktree')

    return [BRANCH]
  })
  vi.mocked(removeIdeWorktreeFolders).mockImplementation(async () => {
    state.order.push('ide-folders')

    return []
  })
  vi.mocked(deleteLocalBranch).mockImplementation(async () => {
    state.order.push('local-branch')
  })
  vi.mocked(deleteRemoteBranch).mockImplementation(async () => {
    state.order.push('remote-branch')
  })
  vi.mocked(removeJiraVersion).mockImplementation(async () => {
    state.order.push('jira')
  })
})

describe('release remove — step order', () => {
  it('runs the six steps in ascending order of irreversibility', async () => {
    await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(state.order).toEqual(['worktree', 'ide-folders', 'pr', 'local-branch', 'remote-branch', 'jira'])
  })
})

describe('release remove — abort at step 5 stops before the unrecoverable step', () => {
  it('never reaches removeJiraVersion', async () => {
    vi.mocked(deleteRemoteBranch).mockRejectedValue(new Error('remote ref does not exist'))

    await expect(releaseRemove({ confirmedCommand: true, version: LABEL })).rejects.toThrow()

    expect(state.order).toEqual(['worktree', 'ide-folders', 'pr', 'local-branch'])
    expect(removeJiraVersion).not.toHaveBeenCalled()
  })

  it('throws an OperationError enumerating the completed steps, the surviving version and the tip sha', async () => {
    vi.mocked(deleteRemoteBranch).mockRejectedValue(new Error('remote ref does not exist'))

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(OperationError)

    const { message } = error as Error

    expect(message).toContain('step 5 of 6 (delete the remote branch)')
    expect(message).toContain(`completed: worktree, ide-folders, pr, local-branch (was ${LOCAL_TIP.slice(0, 7)})`)
    expect(message).toContain(`The Jira fix version ${JIRA_NAME} was NOT removed`)
    // The FULL sha, not the 7-char display prefix: after steps 4-5 this is the only handle that
    // restores the branch, and `git branch -D`’s own `(was <sha>)` output is discarded by
    // `deleteLocalBranch`.
    expect(message).toContain(`git branch ${BRANCH} ${LOCAL_TIP}`)
  })
})

describe('release remove — a throwing editor cleanup is the one non-blocking step', () => {
  it('runs steps 3-6 anyway and reports the IDE step as attempted', async () => {
    vi.mocked(removeIdeWorktreeFolders).mockImplementation(async () => {
      state.order.push('ide-folders')

      throw new Error('EACCES: cursor workspace file is read-only')
    })

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(state.order).toEqual(['worktree', 'ide-folders', 'pr', 'local-branch', 'remote-branch', 'jira'])
    expect(result.structuredContent.ideFolders.outcome).toBe('attempted')
    expect(result.structuredContent.jira).toBe('removed')
  })
})
