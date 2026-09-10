import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listCmuxWorkspacesByCwd } from 'src/integrations/cmux'
import { getVersionRelatedIssueCounts } from 'src/integrations/jira/remove-version'
import { commandEcho } from 'src/lib/command-echo'
import { isMcpMode } from 'src/lib/mcp-mode'

import { releaseRemove } from '../release-remove'
import {
  BASE_BRANCH,
  JIRA_NAME,
  LABEL,
  LOCAL_TIP,
  MOVE_TARGET_NAME,
  PR_NUMBER,
  REMOTE_TIP,
  WORKTREE_PATH,
  installDefaults,
} from './release-remove-mocks'

/**
 * @fileoverview
 * The confirmation text is the inventory, and that is a design commitment, not a cosmetic one.
 *
 * The plan rejects a plan-then-apply shape (a separate `--dry-run` / preview mode) on the grounds
 * that this single message already carries everything a preview would print. Without this suite that
 * rejection rests on an unasserted string: someone trims the message to one line, the rejected
 * alternative silently becomes the right answer again, and nothing fails.
 *
 * The false-success: an operator types `y` to a message that says only "Remove release 1.2.5?" and
 * thereby consents to closing a PR they had not noticed, deleting a remote branch, and — the one
 * unrecoverable act — removing a Jira fix version that two colleagues have tickets against.
 *
 * The two issue counts are asserted SEPARATELY and their sum asserted absent. They count two
 * different fields and one issue can carry the version in both, so a summed total is not a
 * conservative simplification, it is a wrong number.
 *
 * Mocked: git, gh, cmux, Jira, zx, and `@inquirer/confirm` — whose recorded argument IS the assertion
 * target. Real: `buildConfirmMessage` and every string it composes.
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

const confirmMessage = (): string => {
  return vi.mocked(confirm).mock.calls[0]?.[0].message ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  zx.commands = []
  zx.overrides = []

  installDefaults()
  vi.mocked(isMcpMode).mockReturnValue(false)
  vi.mocked(confirm).mockResolvedValue(true)
  // Two issues on each field, so the counts are distinguishable from each other and from their sum;
  // `--move-issues-to` is what lets a version with attached issues reach the confirm at all.
  vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 2, issuesAffectedCount: 3 })
})

describe('release remove — the confirm text carries the whole inventory', () => {
  it('names the pull request and its state', async () => {
    await releaseRemove({ confirmedCommand: false, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    expect(confirmMessage()).toContain(`#${String(PR_NUMBER)} (OPEN)`)
  })

  it('names both issue counts separately, and never their sum', async () => {
    await releaseRemove({ confirmedCommand: false, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    const message = confirmMessage()

    expect(message).toContain('fixVersion on 2 issue(s)')
    expect(message).toContain('affectsVersion on 3 issue(s)')
    expect(message).not.toContain('5 issue(s)')
  })

  it('names the fix version and where its issues are going', async () => {
    await releaseRemove({ confirmedCommand: false, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    expect(confirmMessage()).toContain(`${JIRA_NAME} —`)
    expect(confirmMessage()).toContain(`reassigned to ${MOVE_TARGET_NAME}`)
  })

  it('names the worktree path, the base branch it will switch to, and both tip shas', async () => {
    await releaseRemove({ confirmedCommand: false, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    const message = confirmMessage()

    expect(message).toContain(WORKTREE_PATH)
    expect(message).toContain(`switching to ${BASE_BRANCH} first`)
    // The local tip is the handle that restores the branch after step 4; consenting without seeing it
    // is consenting to a deletion with no stated way back.
    expect(message).toContain(LOCAL_TIP)
    expect(message).toContain(REMOTE_TIP)
  })

  it('warns that the cmux window rooted at the worktree will close, when one is open', async () => {
    vi.mocked(listCmuxWorkspacesByCwd).mockResolvedValue(new Map([[WORKTREE_PATH, 'workspace-ref']]))

    await releaseRemove({ confirmedCommand: false, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    expect(confirmMessage()).toContain(`the cmux window rooted at ${WORKTREE_PATH} will close`)
  })

  it('omits the cmux warning when no window is rooted there', async () => {
    await releaseRemove({ confirmedCommand: false, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    expect(confirmMessage()).not.toContain('cmux window')
  })
})
