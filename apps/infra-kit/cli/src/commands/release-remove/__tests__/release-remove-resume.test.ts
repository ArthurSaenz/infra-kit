import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchPRByHead } from 'src/integrations/gh/pr-status'
import { findVersionByName } from 'src/integrations/jira'
import { removeJiraVersion } from 'src/integrations/jira/remove-version'
import { commandEcho } from 'src/lib/command-echo'
import { getCurrentWorktrees, lsRemoteHead, revParseVerify } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { isMcpMode } from 'src/lib/mcp-mode'
import { removeReleaseWorktreeIfPresent } from 'src/lib/worktrees/remove-release-worktree'

import { releaseRemove } from '../release-remove'
import { LABEL, findVersionByNameFake, installDefaults, releasePr } from './release-remove-mocks'

/**
 * @fileoverview
 * The resume run — this command’s PRIMARY use case, and the one a copied guard would break.
 *
 * `worktrees-remove` validates its targets against `currentWorktrees` (`worktrees-remove.ts:66`).
 * Copying that here would refuse EVERY resume: after the first run the worktree is gone by design,
 * the PR is CLOSED and both branches are deleted, so a target check against live worktrees rejects
 * precisely the state this command creates. `release remove` therefore applies NO target validation
 * to `--version`.
 *
 * That leaves one real hazard, and the third test is the whole reason the terminal predicate exists:
 * a TYPO must not exit 0 with an "everything skipped" success. `--version 9.9.9` against an
 * untouched repo has to THROW. The predicate that separates the two cases is that a release this
 * command removed keeps a CLOSED PR forever — so the PR conjunct fires on a genuine re-run and never
 * on a name that was never a release.
 *
 * The false-success pinned: an operator who typos a version, sees exit 0 and a report of six skipped
 * steps, and concludes the release was already cleaned up — while the real release is still live.
 *
 * Mocked: git, gh, cmux, Jira and zx. Real: the step control flow, the skip reasons it reports, and
 * `assertSomethingExists`.
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

/** The state a completed first run leaves behind: nothing but the CLOSED PR it deliberately keeps. */
const alreadyTornDown = (): void => {
  vi.mocked(getCurrentWorktrees).mockResolvedValue([])
  vi.mocked(removeReleaseWorktreeIfPresent).mockResolvedValue([])
  vi.mocked(fetchPRByHead).mockResolvedValue(releasePr({ state: 'CLOSED' }))
  vi.mocked(revParseVerify).mockResolvedValue(null)
  vi.mocked(lsRemoteHead).mockResolvedValue(null)
  vi.mocked(findVersionByName).mockImplementation(findVersionByNameFake([]))
}

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  zx.commands = []
  zx.overrides = []

  installDefaults()
  vi.mocked(isMcpMode).mockReturnValue(false)
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('release remove — re-run against an already-torn-down release', () => {
  /**
   * The resume path is where a bare `✅ <label>` was maximally wrong: all six steps are legitimate
   * no-ops, yet each logged bytes identical to a run that really removed six things.
   *
   * §5.5 makes the log a reconstruction surface — "a partial run is reconstructable from the log
   * alone" — so a reader trusting it would conclude a release had just been torn down when nothing
   * was touched. The structured result stayed truthful throughout, which is exactly why nothing else
   * in this suite can catch a revert.
   */
  it('logs each step with its outcome, so six no-ops do not read as six removals', async () => {
    alreadyTornDown()

    await releaseRemove({ confirmedCommand: true, version: LABEL })

    const successLines = vi.mocked(logger.info).mock.calls.flatMap((call: unknown[]) => {
      const message = typeof call[1] === 'string' ? call[1] : ''

      return message.startsWith('✅') ? [message] : []
    })

    expect(successLines).not.toHaveLength(0)
    for (const line of successLines as string[]) {
      expect(line).toMatch(/ — \S+$/)
    }
    // The step with the most to lie about: an empty `removed` array is evidence of nothing, so
    // `skipped` must be visible rather than collapsed into a bare success.
    expect(
      successLines.some((line) => {
        return line.includes('configured editors — skipped')
      }),
    ).toBe(true)
  })

  it('succeeds, reporting every step as a no-op with its own reason', async () => {
    alreadyTornDown()

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(result.structuredContent).toMatchObject({
      worktree: 'absent',
      pr: 'already-closed',
      localBranch: 'absent',
      remoteBranch: 'absent',
      jira: 'absent',
      localTipSha: null,
      remoteTipSha: null,
      jiraVersion: null,
    })
    // Nothing was left for a human to finish: no version to remove, so none was requested.
    expect(removeJiraVersion).not.toHaveBeenCalled()
  })

  it('reports the IDE step as skipped rather than claiming an editor diff it never made', async () => {
    alreadyTornDown()

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(result.structuredContent.ideFolders).toEqual({ outcome: 'skipped', providers: [] })
  })
})

describe('release remove — --version is not validated against live worktrees', () => {
  it('accepts a release with no OPEN pull request', async () => {
    // No PR at all, worktree gone: only the local branch survives. A target check against
    // `currentWorktrees` or against open PRs would refuse this, and it is a legitimate resume.
    vi.mocked(getCurrentWorktrees).mockResolvedValue([])
    vi.mocked(removeReleaseWorktreeIfPresent).mockResolvedValue([])
    vi.mocked(fetchPRByHead).mockResolvedValue(null)
    vi.mocked(lsRemoteHead).mockResolvedValue(null)

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(result.structuredContent).toMatchObject({ pr: 'absent', prNumber: null, localBranch: 'deleted' })
  })
})

describe('release remove — the typo case', () => {
  it('throws on a version that never existed, instead of exiting 0 with six skipped steps', async () => {
    // Untouched repo: no worktree, no PR in any state, no branches, no fix version.
    vi.mocked(getCurrentWorktrees).mockResolvedValue([])
    vi.mocked(removeReleaseWorktreeIfPresent).mockResolvedValue([])
    vi.mocked(fetchPRByHead).mockResolvedValue(null)
    vi.mocked(revParseVerify).mockResolvedValue(null)
    vi.mocked(lsRemoteHead).mockResolvedValue(null)
    vi.mocked(findVersionByName).mockImplementation(findVersionByNameFake([]))

    const error = await releaseRemove({ confirmedCommand: true, version: '9.9.9' }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('nothing named "9.9.9" exists to remove')
    expect((error as Error).message).toContain('infra-kit release list')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('does not mistake a genuine re-run for a typo: the CLOSED PR is what tells them apart', async () => {
    alreadyTornDown()

    await expect(releaseRemove({ confirmedCommand: true, version: LABEL })).resolves.toBeDefined()
  })
})
