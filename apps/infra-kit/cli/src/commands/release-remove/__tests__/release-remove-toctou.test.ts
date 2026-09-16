import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getVersionRelatedIssueCounts, removeJiraVersion } from 'src/integrations/jira/remove-version'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { deleteLocalBranch, deleteRemoteBranch } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { removeReleaseWorktreeIfPresent } from 'src/lib/worktrees/remove-release-worktree'

import { releaseRemove } from '../release-remove'
import { JIRA_NAME, LABEL, LOCAL_TIP, installDefaults } from './release-remove-mocks'

/**
 * @fileoverview
 * The time-of-check/time-of-use gap in front of the one call that cannot be undone.
 *
 * The issue-attachment guard runs in preflight. Between it and `removeJiraVersion` sit an
 * interactive confirm of unbounded duration and five mutations across two remote systems. A
 * colleague attaching a ticket to the fix version in that window — the ordinary workflow of a team
 * filing against an open release — is invisible to a guard that already passed.
 *
 * The false-success this pins is precise: a guard that passed six steps ago AUTHORISING an
 * unrecoverable call. The command would report success, and the issues would have lost their version
 * links with nothing recording what they were.
 *
 * Both directions are asserted, because only the pair is meaningful. Unchanged counts must proceed
 * SILENTLY — a re-probe that warned on every run would train operators to ignore it — and changed
 * counts must abort BEFORE the delete, reporting steps 1-5 done and the version intact so the
 * re-run finishes the job with the guard re-evaluated against the new counts.
 *
 * Mocked: git, gh, Orca, Jira and zx; `getVersionRelatedIssueCounts` answers differently on its
 * first and second call, which is what makes the two reads distinguishable at all. Real: the step
 * control flow and the residue report.
 */

const zx = vi.hoisted(() => {
  return { commands: [] as string[], overrides: [] as { match: string; stdout?: string; throws?: unknown }[] }
})

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()
  // Imported INSIDE the factory: this file's own top-level bindings are still in their temporal dead
  // zone while the factory runs.
  const { createZx } = await import('./release-remove-zx')

  return { ...actual, $: createZx(zx) }
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
  zx.commands = []
  zx.overrides = []

  installDefaults()
  agentMode.source = null
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('release remove — issue counts unchanged since preflight', () => {
  it('removes the fix version and logs no extra warning', async () => {
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 0, issuesAffectedCount: 0 })

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(result.structuredContent.jira).toBe('removed')
    expect(removeJiraVersion).toHaveBeenCalledTimes(1)
    // The guard re-read the counts rather than trusting preflight.
    expect(getVersionRelatedIssueCounts).toHaveBeenCalledTimes(2)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('release remove — issue counts changed since preflight', () => {
  it('aborts before removeJiraVersion', async () => {
    vi.mocked(getVersionRelatedIssueCounts)
      .mockResolvedValueOnce({ issuesFixedCount: 0, issuesAffectedCount: 0 })
      .mockResolvedValue({ issuesFixedCount: 1, issuesAffectedCount: 0 })

    await expect(releaseRemove({ confirmedCommand: true, version: LABEL })).rejects.toThrow(/issue counts changed/)

    expect(removeJiraVersion).not.toHaveBeenCalled()
  })

  it('reports steps 1-5 complete and the fix version intact, and says how to finish', async () => {
    vi.mocked(getVersionRelatedIssueCounts)
      .mockResolvedValueOnce({ issuesFixedCount: 0, issuesAffectedCount: 0 })
      .mockResolvedValue({ issuesFixedCount: 2, issuesAffectedCount: 1 })

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    const { message } = error as Error

    expect(message).toContain('step 6 of 6 (remove the Jira fix version)')
    expect(message).toContain(`completed: worktree, ide-folders, pr, local-branch (was ${LOCAL_TIP.slice(0, 7)})`)
    expect(message).toContain('remote-branch')
    expect(message).toContain(`The Jira fix version ${JIRA_NAME} was NOT removed`)
    // Both old and new counts, so the operator can see WHAT moved before deciding.
    expect(message).toContain('fixVersion 0 → 2, affectsVersion 0 → 1')
    expect(message).toContain(`re-run \`infra-kit release remove --version ${LABEL}\``)
  })

  it('leaves the five completed steps done: the abort is a stop, not a rollback', async () => {
    vi.mocked(getVersionRelatedIssueCounts)
      .mockResolvedValueOnce({ issuesFixedCount: 0, issuesAffectedCount: 0 })
      .mockResolvedValue({ issuesFixedCount: 1, issuesAffectedCount: 0 })

    await expect(releaseRemove({ confirmedCommand: true, version: LABEL })).rejects.toThrow()

    expect(removeReleaseWorktreeIfPresent).toHaveBeenCalledTimes(1)
    expect(deleteLocalBranch).toHaveBeenCalledTimes(1)
    expect(deleteRemoteBranch).toHaveBeenCalledTimes(1)
  })

  it('over MCP: aborts the same way, and the WHOLE remediation says re-call, never the CLI command', async () => {
    agentMode.source = 'mcp'
    vi.mocked(getVersionRelatedIssueCounts)
      .mockResolvedValueOnce({ issuesFixedCount: 0, issuesAffectedCount: 0 })
      .mockResolvedValue({ issuesFixedCount: 1, issuesAffectedCount: 0 })

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect(removeJiraVersion).not.toHaveBeenCalled()

    // The message is TWO halves — the refusal's remediation, then the residue report's re-run
    // sentence — and both are forked: one CLI command surviving in either would tell an agent to do
    // two contradictory things in one sentence.
    const { message } = error as Error

    expect(message).toContain('issue counts changed')
    expect(message).toContain('re-call release-remove')
    expect(message).not.toContain('infra-kit release remove')
  })
})
