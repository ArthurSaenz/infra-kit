import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { findVersionByName, loadJiraConfigOptional } from 'src/integrations/jira'
import { getVersionRelatedIssueCounts, removeJiraVersion } from 'src/integrations/jira/remove-version'
import { commandEcho } from 'src/lib/command-echo'
import { deleteLocalBranch, deleteRemoteBranch } from 'src/lib/git-utils'
import { isMcpMode } from 'src/lib/mcp-mode'
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
 * D7 — the MCP narrowing: an agent may perform every reversible step and may NEVER perform the one
 * irreversible one.
 *
 * `removeAndSwap` cannot be undone. The new version carries a new id and a new URL, and nothing in
 * Jira records which issues used to point at the old one — so an agent that misread a version name
 * destroys work no undo exists for. Over MCP the Jira step is therefore never attempted, and the
 * result hands a human the id, name and URL instead.
 *
 * Two flags are REFUSED rather than ignored, and the difference matters: accepting `moveIssuesTo`
 * would let an agent report a reassignment that never happened, and accepting `skipJira` would name
 * an exception to a step that does not run. The guard lives on the shared handler, not only on the
 * tool schema, so a direct call cannot slip past it.
 *
 * The count guard is the one refusal that is MCP-SCOPED, and the reason is that it protects the
 * DELETE. Over MCP no delete happens, `--move-issues-to` — the escape hatch the refusal’s own message
 * points at — is itself refused, so firing it there is a refusal with no exit: an agent can neither
 * proceed nor satisfy it. The released/archived refusal is deliberately NOT scoped the same way: it
 * means the release has shipped, which is a reason to refuse the whole teardown, not just one step.
 * The pair is asserted together because either alone is satisfiable by deleting the wrong thing.
 *
 * The last describe is the one that keeps the rest honest, and it needs BOTH halves. Without the
 * "Jira still runs on the CLI" half, a command that simply broke the Jira step would satisfy every
 * MCP assertion above. Without the "the flags are still accepted on the CLI" half, a guard that
 * refused `moveIssuesTo`/`skipJira` unconditionally — on every path, not just MCP — would also
 * satisfy them, and only T2’s move-target case would notice.
 *
 * Mocked: git, gh, cmux, Jira and zx. Real: `isMcpMode` is a spy, so each test states its own mode.
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

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  zx.commands = []
  zx.overrides = []

  installDefaults()
  vi.mocked(confirm).mockResolvedValue(true)
  // The MCP boundary injects `confirmedCommand: true` into every call it lets through.
  vi.mocked(isMcpMode).mockReturnValue(true)
})

describe('release remove — MCP input guards', () => {
  it('requires version, naming the field in its remediation', async () => {
    const error = await releaseRemove({ confirmedCommand: true }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('requires "version"')
    expect((error as Error).message).toContain('pass "version"')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('refuses moveIssuesTo, pointing at the manual hand-off instead', async () => {
    const error = await releaseRemove({
      confirmedCommand: true,
      version: LABEL,
      moveIssuesTo: MOVE_TARGET_NAME,
    }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('moveIssuesTo is not permitted over MCP')
    expect((error as Error).message).toContain('jira: "manual"')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('refuses skipJira as meaningless where the step never runs', async () => {
    await expect(releaseRemove({ confirmedCommand: true, version: LABEL, skipJira: true })).rejects.toThrow(
      /skipJira is meaningless over MCP/,
    )

    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('does not advertise the two CLI-only flags in its input schema', () => {
    expect(Object.keys(releaseRemoveMcpTool.inputSchema)).toEqual(['version', 'confirm'])
  })
})

describe('release remove — the Jira step over MCP', () => {
  it('never calls removeJiraVersion, and hands back the id, name and URL for a human', async () => {
    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(removeJiraVersion).not.toHaveBeenCalled()
    expect(result.structuredContent.jira).toBe('manual')
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

  it('skips even the TOCTOU re-probe, because there is no delete to authorise', async () => {
    await releaseRemove({ confirmedCommand: true, version: LABEL })

    // Preflight only. A second read would mean the code walked into the guard that exists solely to
    // gate `removeJiraVersion`.
    expect(getVersionRelatedIssueCounts).toHaveBeenCalledTimes(1)
  })
})

describe('release remove — the narrowing is MCP-scoped, not a general disablement', () => {
  it('runs the Jira step on the CLI path with the same inputs', async () => {
    vi.mocked(isMcpMode).mockReturnValue(false)

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(removeJiraVersion).toHaveBeenCalledTimes(1)
    expect(result.structuredContent.jira).toBe('removed')
  })

  it('accepts moveIssuesTo and skipJira on the CLI path', async () => {
    vi.mocked(isMcpMode).mockReturnValue(false)
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 1, issuesAffectedCount: 1 })

    const moved = await releaseRemove({ confirmedCommand: true, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    expect(moved.structuredContent.jira).toBe('removed')

    const skipped = await releaseRemove({ confirmedCommand: true, version: LABEL, skipJira: true })

    expect(skipped.structuredContent.jira).toBe('skipped')
  })
})

describe('release remove — the count guard is scoped to the paths that delete', () => {
  it('removes a release whose fix version still carries issues, leaving the version for a human', async () => {
    // On the CLI this refuses. Over MCP the counts guard a mutation that cannot occur, and the flag
    // that would satisfy them is refused on this very path — so firing here strands the agent.
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 2, issuesAffectedCount: 3 })

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(result.structuredContent.jira).toBe('manual')
    expect(result.structuredContent.jiraVersion).toEqual({
      id: JIRA_VERSION_ID,
      name: JIRA_NAME,
      url: JIRA_VERSION_URL,
    })
    expect(removeJiraVersion).not.toHaveBeenCalled()
    // Steps 1-5 ran: the reversible teardown is exactly what an agent is allowed to do.
    expect(removeReleaseWorktreeIfPresent).toHaveBeenCalledTimes(1)
    expect(deleteLocalBranch).toHaveBeenCalledTimes(1)
    expect(deleteRemoteBranch).toHaveBeenCalledTimes(1)
  })

  it('still reads the counts in preflight, so the version it hands back is reported with them', async () => {
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 2, issuesAffectedCount: 3 })

    await releaseRemove({ confirmedCommand: true, version: LABEL })

    // Skipping the REFUSAL is not the same as skipping the QUERY: the counts still reach the debug
    // projection of the plan, which is the only record of what the version carried when it was left.
    expect(getVersionRelatedIssueCounts).toHaveBeenCalledTimes(1)
  })

  it('still refuses a RELEASED version over MCP, before any mutation', async () => {
    // D2c is not scoped: released means shipped, which refuses the whole teardown and not merely the
    // Jira step. A refactor that scoped both guards to the deleting paths fails here.
    vi.mocked(findVersionByName).mockImplementation(
      findVersionByNameFake([jiraVersion({ released: true }), moveTargetVersion()]),
    )

    await expect(releaseRemove({ confirmedCommand: true, version: LABEL })).rejects.toThrow(/is already released/)

    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
    expect(deleteLocalBranch).not.toHaveBeenCalled()
    expect(removeJiraVersion).not.toHaveBeenCalled()
  })

  it('still refuses an ARCHIVED version over MCP', async () => {
    vi.mocked(findVersionByName).mockImplementation(
      findVersionByNameFake([jiraVersion({ archived: true }), moveTargetVersion()]),
    )

    await expect(releaseRemove({ confirmedCommand: true, version: LABEL })).rejects.toThrow(/is already archived/)

    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('keeps refusing the same attached-issue version on the CLI path', async () => {
    // Without this the whole count guard could be deleted and every assertion above would still pass.
    vi.mocked(isMcpMode).mockReturnValue(false)
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 2, issuesAffectedCount: 3 })

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('fixVersion on 2 issue(s)')
    expect((error as Error).message).toContain('affectsVersion on 3 issue(s)')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  /**
   * An unconfigured Jira must not hand an agent a flag this same command refuses.
   *
   * The false-success is a LOOP rather than a wrong mutation: `assertMcpRemoveInput` refuses
   * `skipJira` over MCP, so a refusal whose remediation reads "or pass --skip-jira" sends the caller
   * straight back into "skipJira is meaningless over MCP". Nothing is mutated either way, so no
   * mutation assertion can catch it — only the text can. The exit that does exist over MCP is the
   * session's `env-load` file, re-applied to `process.env` at every tool call's entry, so the
   * remediation has to name `env-load` — not an environment the server was launched with.
   */
  it('does not offer --skip-jira as the way out when Jira is unconfigured over MCP', async () => {
    vi.mocked(isMcpMode).mockReturnValue(true)
    vi.mocked(loadJiraConfigOptional).mockResolvedValue(null)

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('Jira is not configured')
    expect((error as Error).message).toContain('call `env-load`')
    expect((error as Error).message).not.toContain('launched with')
    expect((error as Error).message).not.toContain('pass --skip-jira')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('still offers --skip-jira on the CLI path, where it is a real exit', async () => {
    vi.mocked(isMcpMode).mockReturnValue(false)
    vi.mocked(loadJiraConfigOptional).mockResolvedValue(null)

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('pass --skip-jira')
  })
})
