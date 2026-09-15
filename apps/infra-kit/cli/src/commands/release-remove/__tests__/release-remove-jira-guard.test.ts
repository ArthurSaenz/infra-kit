import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchPRByHead } from 'src/integrations/gh/pr-status'
import { findVersionByName, loadJiraConfigOptional } from 'src/integrations/jira'
import { getVersionRelatedIssueCounts, removeJiraVersion } from 'src/integrations/jira/remove-version'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { removeReleaseWorktreeIfPresent } from 'src/lib/worktrees/remove-release-worktree'

import { releaseRemove } from '../release-remove'
import {
  JIRA_VERSION_ID,
  LABEL,
  MOVE_TARGET_ID,
  MOVE_TARGET_NAME,
  findVersionByNameFake,
  installDefaults,
  jiraVersion,
  moveTargetVersion,
} from './release-remove-mocks'

/**
 * @fileoverview
 * D2b/D2c/D2d — the three Jira refusals, which are three guards and not one.
 *
 * The false-success each prevents is a fix version deleted with its issue links: `removeAndSwap` is
 * irreversible, the new version gets a new id and a new URL, and nothing in Jira remembers which
 * issues used to point at the old one. So every refusal test asserts `removeJiraVersion` was called
 * ZERO times, not merely that the promise rejected.
 *
 * Three specific collapses are pinned:
 *   - a `released` version is refused WITH THE PR MOCKED ABSENT, so the test cannot pass by way of
 *     the MERGED-PR guard; a later refactor that folds D2c into D3 fails here.
 *   - `issuesFixedCount: 0, issuesAffectedCount: 2` — the dead end an earlier draft shipped, where
 *     an affects-only version was permanently unremovable. It must refuse without the flag and
 *     SUCCEED with it.
 *   - `--move-issues-to` must map to BOTH `moveFixIssuesTo` and `moveAffectedIssuesTo`. Mapping the
 *     one flag to the fix field alone would lose the affects links through the very flag that exists
 *     to prevent losing them.
 *
 * D2d’s asymmetry with `deliverJiraReleaseSafely` gets its own case: an unconfigured Jira REFUSES
 * here rather than degrading to a warning, and only `--skip-jira` proceeds. That is exactly the
 * behaviour a later "make the Jira paths consistent" refactor would delete.
 *
 * Mocked: git, gh, cmux, the four Jira network calls, and zx. Real: `buildJiraVersionUrl`, the
 * release-id parsing, and the guard order under test.
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
  zx.commands = []
  zx.overrides = []

  installDefaults()
  agentMode.source = null
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('release remove — Jira issue-attachment guard (D2b)', () => {
  it('refuses when the fix version is still set as fixVersion on issues, removing no version', async () => {
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 3, issuesAffectedCount: 0 })

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('fixVersion on 3 issue(s)')
    expect(removeJiraVersion).not.toHaveBeenCalled()
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('refuses an affects-only version without the flag, and REMOVES it with the flag', async () => {
    // The earlier drafts dead end: 0 fixVersion issues but 2 affectsVersion issues made the version
    // permanently unremovable, because the refusal fired and no flag could satisfy it.
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 0, issuesAffectedCount: 2 })

    const refusal = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((refusal as Error).message).toContain('affectsVersion on 2 issue(s)')
    expect(removeJiraVersion).not.toHaveBeenCalled()

    const result = await releaseRemove({
      confirmedCommand: true,
      version: LABEL,
      moveIssuesTo: MOVE_TARGET_NAME,
    })

    expect(result.structuredContent.jira).toBe('removed')
    expect(removeJiraVersion).toHaveBeenCalledTimes(1)
  })

  it('never sums the two counts: the refusal reports each field separately', async () => {
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 2, issuesAffectedCount: 3 })

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    const { message } = error as Error

    // One issue can carry the version in BOTH fields, so 2 + 3 is an upper bound on distinct issues,
    // not a total — a summed "5 issue(s)" would be a number that is simply wrong.
    expect(message).toContain('fixVersion on 2 issue(s)')
    expect(message).toContain('affectsVersion on 3 issue(s)')
    expect(message).not.toContain('5 issue(s)')
  })
})

describe('release remove — released/archived guard (D2c) is independent of the PR guard (D3)', () => {
  it('refuses a released fix version even with NO pull request at all', async () => {
    // PR absent, so D3 cannot possibly be what refuses: a refactor that folded D2c into the
    // MERGED-PR check would let this through.
    vi.mocked(fetchPRByHead).mockResolvedValue(null)
    vi.mocked(findVersionByName).mockImplementation(
      findVersionByNameFake([jiraVersion({ released: true }), moveTargetVersion()]),
    )

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('is already released')
    expect((error as Error).message).toContain('un-release it in Jira first')
    expect(removeJiraVersion).not.toHaveBeenCalled()
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('refuses an archived fix version on the same guard', async () => {
    vi.mocked(fetchPRByHead).mockResolvedValue(null)
    vi.mocked(findVersionByName).mockImplementation(
      findVersionByNameFake([jiraVersion({ archived: true }), moveTargetVersion()]),
    )

    await expect(releaseRemove({ confirmedCommand: true, version: LABEL })).rejects.toThrow(/is already archived/)

    expect(removeJiraVersion).not.toHaveBeenCalled()
  })
})

describe('release remove — --move-issues-to', () => {
  it('passes the ONE flag as BOTH moveFixIssuesTo and moveAffectedIssuesTo', async () => {
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 1, issuesAffectedCount: 1 })

    await releaseRemove({ confirmedCommand: true, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    expect(vi.mocked(removeJiraVersion).mock.calls[0]?.[0]).toEqual({
      versionId: JIRA_VERSION_ID,
      moveFixIssuesTo: MOVE_TARGET_ID,
      moveAffectedIssuesTo: MOVE_TARGET_ID,
    })
  })

  it('fails a typo’d target in PREFLIGHT, before the worktree is touched', async () => {
    // Resolved in preflight rather than at step 6, so a bad target costs nothing: at step 6 the
    // worktree, the PR and both branches would already be gone.
    const error = await releaseRemove({
      confirmedCommand: true,
      version: LABEL,
      moveIssuesTo: 'v9.9.9',
    }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('no Jira fix version named "v9.9.9"')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
    expect(removeJiraVersion).not.toHaveBeenCalled()
  })
})

describe('release remove — Jira unconfigured (D2d)', () => {
  it('refuses rather than silently skipping the fix version', async () => {
    vi.mocked(loadJiraConfigOptional).mockResolvedValue(null)

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('Jira is not configured')
    expect((error as Error).message).toContain('--skip-jira')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('proceeds with --skip-jira, reporting the Jira step as skipped and querying Jira not at all', async () => {
    vi.mocked(loadJiraConfigOptional).mockResolvedValue(null)

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL, skipJira: true })

    expect(result.structuredContent.jira).toBe('skipped')
    expect(result.structuredContent.jiraVersion).toBeNull()
    expect(loadJiraConfigOptional).not.toHaveBeenCalled()
    expect(findVersionByName).not.toHaveBeenCalled()
    expect(removeJiraVersion).not.toHaveBeenCalled()
  })
})
