import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { getVersionRelatedIssueCounts } from 'src/integrations/jira/remove-version'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'

import { releaseRemove, releaseRemoveMcpTool } from '../release-remove'
import { LABEL, MOVE_TARGET_NAME, installDefaults } from './release-remove-mocks'

/**
 * @fileoverview
 * `commandEcho` parity: the printed "equivalent command" must be an invocation that reproduces the
 * run, and the MCP tool’s `outputSchema` must accept what the handler actually returns.
 *
 * The false-success on the echo side is an interactive run whose printed line silently omits a flag —
 * an operator who copies it gets a DIFFERENT teardown from the one they just approved, and for the
 * `--move-issues-to` flag specifically that difference is a refusal instead of a reassignment.
 * Nothing but executor discipline keeps `addOption` in step with the flags, so it is pinned here.
 *
 * The false-success on the schema side is a handler and a declared output that have drifted apart: an
 * MCP client validates `structuredContent` against the tool’s `outputSchema`, so a field the handler
 * renamed (or a `jira` value the enum does not list) fails at the client, not here. The zod
 * round-trip is the same one `worktrees-remove`’s report test performs.
 *
 * Mocked: git, gh, cmux, Jira and zx. Real: `commandEcho` itself, and the zod schema the tool declares.
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

const outputSchema = z.object(releaseRemoveMcpTool.outputSchema)

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  zx.commands = []
  zx.overrides = []

  installDefaults()
  agentMode.source = null
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('release remove — commandEcho parity', () => {
  it('records --version, --move-issues-to and --yes for an interactive, confirmed run', async () => {
    vi.mocked(getVersionRelatedIssueCounts).mockResolvedValue({ issuesFixedCount: 1, issuesAffectedCount: 0 })

    await releaseRemove({ confirmedCommand: false, version: LABEL, moveIssuesTo: MOVE_TARGET_NAME })

    expect(commandEcho.formatOptions()).toBe(`--version "${LABEL}" --move-issues-to "${MOVE_TARGET_NAME}" --yes`)
  })

  it('records --skip-jira, and omits --yes when the caller already passed --yes', async () => {
    await releaseRemove({ confirmedCommand: true, version: LABEL, skipJira: true })

    expect(commandEcho.formatOptions()).toBe(`--version "${LABEL}" --skip-jira`)
  })

  it('echoes the RESOLVED label, so a branch-shaped argument replays as the version flag takes', async () => {
    await releaseRemove({ confirmedCommand: true, version: 'release/v1.2.5' })

    expect(commandEcho.formatOptions()).toBe(`--version "${LABEL}"`)
  })
})

describe('release remove — MCP output schema round-trip', () => {
  it('accepts the structuredContent a CLI run returns', async () => {
    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(() => {
      return outputSchema.parse(result.structuredContent)
    }).not.toThrow()
  })

  it('accepts the structuredContent an MCP run returns, including jira: "removed"', async () => {
    agentMode.source = 'mcp'

    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    expect(result.structuredContent.jira).toBe('removed')
    expect(() => {
      return outputSchema.parse(result.structuredContent)
    }).not.toThrow()
  })

  it('declares exactly the keys the handler returns, in both directions', async () => {
    const result = await releaseRemove({ confirmedCommand: true, version: LABEL })

    // `parse` alone is one-directional: zod ignores extra keys, so a field the handler added and the
    // schema never learned about would validate cleanly and reach no MCP client.
    expect(Object.keys(result.structuredContent).sort()).toEqual(Object.keys(releaseRemoveMcpTool.outputSchema).sort())
  })

  it('is flagged requiresHumanConfirm for the MCP destructive-op gate', () => {
    expect(releaseRemoveMcpTool.requiresHumanConfirm).toBe(true)
  })
})
