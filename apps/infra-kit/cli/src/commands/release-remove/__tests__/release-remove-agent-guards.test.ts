import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { findVersionByName, loadJiraConfigOptional } from 'src/integrations/jira'
import { getVersionRelatedIssueCounts, removeJiraVersion } from 'src/integrations/jira/remove-version'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { deleteLocalBranch, deleteRemoteBranch } from 'src/lib/git-utils'
import { removeReleaseWorktreeIfPresent } from 'src/lib/worktrees/remove-release-worktree'

import { releaseRemove, releaseRemoveMcpTool } from '../release-remove'
import {
  JIRA_NAME,
  JIRA_VERSION_ID,
  JIRA_VERSION_URL,
  LABEL,
  MOVE_TARGET_NAME,
  findVersionByNameFake,
  installDefaults,
  jiraVersion,
  moveTargetVersion,
} from './release-remove-mocks'

/**
 * @fileoverview
 * The `--agent` path does what a human's run does — the Jira fix version is removed — and every
 * refusal an agent can read names an exit that is reachable from where it fires.
 *
 * `removeAndSwap` cannot be undone, which is why an earlier shape kept it off the agent path
 * entirely. What retired that shape is the confirm gate: the first call previews and exits, the
 * `--yes` re-run is the one the human approved at the Bash prompt. An agent cannot reach the
 * irreversible call alone, so the command no longer pretends the call does not exist there.
 *
 * Of the two Jira flags, `moveIssuesTo` is ACCEPTED and `skipJira` is REFUSED, and the line is what
 * the result would say. `skipJira` loads no Jira state, so the result carries `jiraVersion: null` —
 * a live fix version with nothing pointing at it. `moveIssuesTo` is the exit the count guard names,
 * and that guard fires under `--agent` too. The guard lives on the shared handler, not only on the
 * command schema, so a direct call cannot slip past it.
 *
 * The refusal wording is the CLI's on both paths: `--skip-jira` may be offered as an exit because
 * the agent's re-run WITH it is refused with an "ask a human to run … from their own terminal"
 * hand-off — the loop ends there, one hop in.
 *
 * The "CLI path is unchanged" describe keeps the rest honest and needs BOTH halves: without "Jira
 * still runs on the CLI", a command that removed the version on every path would satisfy the agent
 * assertions by accident; without "the flags are still accepted on the CLI", a guard that refused
 * `skipJira` unconditionally would too.
 *
 * Mocked: git, gh, Orca, Jira and zx. Real: `agentMode`, so each test sets its own source.
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
  vi.mocked(confirm).mockResolvedValue(true)
  // The `--yes` re-run is the only agent call that reaches the handler, and it carries `confirmedCommand`.
  agentMode.source = 'flag'
})

describe('release remove — agent input guards', () => {
  // `refuseMissingArguments` answers first under `--agent`; the handler's own `--version` fallback
  // behind it is reached only if that seam ever lets a bare call through.
  it('refuses a call without --version as argument_required, before any step', async () => {
    const error = await releaseRemove({ confirmedCommand: true }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'argument_required',
      argument: 'version',
    })
    expect((error as Error).message).toContain('pass --version')
    // The retired wording blamed the missing TTY; the causes are listed instead.
    expect((error as Error).message).not.toContain('needs a TTY')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('accepts moveIssuesTo and passes it as BOTH moveFixIssuesTo and moveAffectedIssuesTo', async () => {
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 1, issuesAffectedCount: 1 })

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    expect(result.structuredContent.jira).toBe('removed')
    // ONE field, BOTH parameters: mapping it to the fix links alone would lose the affects links
    // through the very field that exists to prevent data loss.
    expect(removeJiraVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: JIRA_VERSION_ID,
        moveFixIssuesTo: moveTargetVersion().id,
        moveAffectedIssuesTo: moveTargetVersion().id,
      }),
      expect.anything(),
    )
  })

  it('refuses skipJira: the result would be silent about a live fix version', async () => {
    const error = await releaseRemove({ confirmedCommand: true, version: LABEL, skipJira: true }).catch(
      (e: unknown) => {
        return e
      },
    )

    expect((error as Error).message).toMatch(/--skip-jira is not permitted under agent mode/)
    // The hand-off shape, not a caller action: the command appears only after "ask a human to run".
    expect((error as Error).message).toContain('ask a human to run `infra-kit release remove --skip-jira`')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('advertises moveIssuesTo and not skipJira in its input schema', () => {
    expect(Object.keys(releaseRemoveMcpTool.inputSchema)).toEqual(['version', 'moveIssuesTo', 'confirm'])
  })
})

describe('release remove — the Jira step under --agent', () => {
  it('calls removeJiraVersion once with the version id, and reports jira: "removed" with the version', async () => {
    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(removeJiraVersion).toHaveBeenCalledTimes(1)
    expect(removeJiraVersion).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: JIRA_VERSION_ID }),
      expect.anything(),
    )
    expect(result.structuredContent.jira).toBe('removed')
    // Captured BEFORE the delete: after it the id is the only handle that survives.
    expect(result.structuredContent.jiraVersion).toEqual({
      id: JIRA_VERSION_ID,
      name: JIRA_NAME,
      url: JIRA_VERSION_URL,
    })
  })

  it('still performs every reversible step', async () => {
    await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(removeReleaseWorktreeIfPresent).toHaveBeenCalledTimes(1)
    expect(deleteLocalBranch).toHaveBeenCalledTimes(1)
    expect(deleteRemoteBranch).toHaveBeenCalledTimes(1)
  })

  it('runs the TOCTOU re-probe before the delete, exactly as the CLI does', async () => {
    await releaseRemove({ confirmedCommand: true, version: LABEL })

    // Preflight AND the re-probe. A single read would mean the delete was authorised by a guard that
    // passed five mutations ago.
    expect(getVersionRelatedIssueCounts).toHaveBeenCalledTimes(2)
  })
})

describe('release remove — the CLI path is unchanged', () => {
  it('runs the Jira step on the CLI path with the same inputs', async () => {
    agentMode.source = null

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(removeJiraVersion).toHaveBeenCalledTimes(1)
    expect(result.structuredContent.jira).toBe('removed')
  })

  it('accepts moveIssuesTo and skipJira on the CLI path', async () => {
    agentMode.source = null
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 1, issuesAffectedCount: 1 })

    const moved = await releaseRemove({ confirmedCommand: true, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    expect(moved.structuredContent.jira).toBe('removed')

    const skipped = await releaseRemove({ confirmedCommand: true, version: LABEL, skipJira: true })

    expect(skipped.structuredContent.jira).toBe('skipped')
  })
})

describe('release remove — the count guard applies under --agent', () => {
  it('refuses a fix version that still carries issues, with both counts and the flag the re-run can pass', async () => {
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 2, issuesAffectedCount: 3 })

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    const { message } = error as Error

    expect(message).toContain('fixVersion on 2 issue(s)')
    expect(message).toContain('affectsVersion on 3 issue(s)')
    // The exit is a flag the agent's own `--yes` re-run can carry.
    expect(message).toContain('--move-issues-to')
    // Before any mutation: the refusal is preflight's, not step 6's.
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
    expect(deleteLocalBranch).not.toHaveBeenCalled()
    expect(removeJiraVersion).not.toHaveBeenCalled()
  })

  it('proceeds and reassigns when moveIssuesTo names the target', async () => {
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 2, issuesAffectedCount: 3 })

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    expect(result.structuredContent.jira).toBe('removed')
    expect(removeJiraVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        moveFixIssuesTo: moveTargetVersion().id,
        moveAffectedIssuesTo: moveTargetVersion().id,
      }),
      expect.anything(),
    )
  })

  it('still refuses a RELEASED version under --agent, before any mutation', async () => {
    // Released means shipped, which refuses the whole teardown and not merely the Jira step.
    vi.mocked(findVersionByName).mockImplementation(
      findVersionByNameFake([jiraVersion({ released: true }), moveTargetVersion()]),
    )

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    const { message } = error as Error

    expect(message).toMatch(/is already released/)
    expect(message).toContain('un-release it in Jira')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
    expect(deleteLocalBranch).not.toHaveBeenCalled()
    expect(removeJiraVersion).not.toHaveBeenCalled()
  })

  it('still refuses an ARCHIVED version under --agent', async () => {
    vi.mocked(findVersionByName).mockImplementation(
      findVersionByNameFake([jiraVersion({ archived: true }), moveTargetVersion()]),
    )

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    const { message } = error as Error

    expect(message).toMatch(/is already archived/)
    expect(message).toContain('un-release it in Jira')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('keeps refusing the same attached-issue version on the CLI path, naming the flag', async () => {
    // Without this the whole count guard could be deleted and every assertion above would still pass.
    agentMode.source = null
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 2, issuesAffectedCount: 3 })

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('fixVersion on 2 issue(s)')
    expect((error as Error).message).toContain('affectsVersion on 3 issue(s)')
    expect((error as Error).message).toContain('--move-issues-to')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  /**
   * One wording for both paths: an unconfigured Jira names `--skip-jira` even for an agent, whose
   * re-run with it is refused by `assertAgentRemoveInput` with the "ask a human" hand-off — the loop
   * "pass --skip-jira" → "not permitted under agent mode" ends there, one hop in, and nothing is
   * mutated on either hop.
   */
  it.each([
    ['a human at a TTY', null],
    ['an agent', 'flag'],
  ] as const)('offers --skip-jira when Jira is unconfigured, for %s', async (_who, source) => {
    agentMode.source = source
    vi.mocked(loadJiraConfigOptional).mockResolvedValue(null)

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('Jira is not configured')
    expect((error as Error).message).toContain('pass --skip-jira')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })
})
