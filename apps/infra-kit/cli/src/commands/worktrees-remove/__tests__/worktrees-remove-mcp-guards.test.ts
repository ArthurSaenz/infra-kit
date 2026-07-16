import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { commandEcho } from 'src/lib/command-echo'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { isMcpMode } from 'src/lib/mcp-mode'

import { worktreesRemove, worktreesRemoveMcpTool } from '../worktrees-remove'

/**
 * Guards that make `worktrees-remove` safe to expose as an MCP tool:
 *   - over MCP (`isMcpMode()`), `all=true` is rejected — bulk removal has no human gate there
 *   - over MCP, an explicit `versions` is required — the picker needs a TTY
 *   - a `versions` value that names a non-existent worktree errors BEFORE removing anything, on both
 *     the CLI and MCP paths (today `removeWorktrees`' allSettled would swallow it as a no-op success)
 *
 * Only side-effecting collaborators are mocked; `parseReleaseRef`/`formatBranchName` stay real so the
 * version→branch mapping is exercised exactly as in production.
 */

const CURRENT_WORKTREES = ['release/v1.2.5', 'release/v1.2.6']

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { getCurrentWorktrees: vi.fn(), getProjectRoot: vi.fn(), getRepoName: vi.fn() }
})

vi.mock('src/lib/mcp-mode', () => {
  return { isMcpMode: vi.fn() }
})

vi.mock('src/lib/prompts/release-picker', () => {
  return { pickReleaseBranch: vi.fn(), pickReleaseBranches: vi.fn() }
})

vi.mock('src/lib/worktrees', () => {
  return { removeWorktrees: vi.fn() }
})

vi.mock('src/integrations/ide', () => {
  return { removeIdeWorktreeFolders: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/lib/release-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/release-utils')>()

  return { ...actual, getJiraDescriptions: vi.fn().mockResolvedValue(new Map<string, string>()) }
})

vi.mock('@inquirer/confirm', () => {
  return { default: vi.fn().mockResolvedValue(true) }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

beforeEach(async () => {
  vi.clearAllMocks()
  commandEcho.reset()

  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(getCurrentWorktrees).mockResolvedValue(CURRENT_WORKTREES)
  vi.mocked(getProjectRoot).mockResolvedValue('/workspace/project-root')
  vi.mocked(getRepoName).mockResolvedValue('repo')
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])
  vi.mocked(isMcpMode).mockReturnValue(false)

  const { removeWorktrees } = await import('src/lib/worktrees')

  vi.mocked(removeWorktrees).mockResolvedValue([])

  const { removeIdeWorktreeFolders } = await import('src/integrations/ide')

  vi.mocked(removeIdeWorktreeFolders).mockResolvedValue([])
})

describe('worktrees-remove MCP guards', () => {
  it('rejects all=true over MCP and removes nothing', async () => {
    vi.mocked(isMcpMode).mockReturnValue(true)

    await expect(worktreesRemove({ confirmedCommand: true, all: true })).rejects.toThrow(/all=true is not permitted/)

    const { removeWorktrees } = await import('src/lib/worktrees')

    expect(removeWorktrees).not.toHaveBeenCalled()
  })

  it('requires explicit versions over MCP', async () => {
    vi.mocked(isMcpMode).mockReturnValue(true)

    await expect(worktreesRemove({ confirmedCommand: true })).rejects.toThrow(/over MCP requires/)

    const { removeWorktrees } = await import('src/lib/worktrees')

    expect(removeWorktrees).not.toHaveBeenCalled()
  })

  it('allows an explicit, matching versions target over MCP', async () => {
    vi.mocked(isMcpMode).mockReturnValue(true)

    await worktreesRemove({ confirmedCommand: true, versions: '1.2.5' })

    const { removeWorktrees } = await import('src/lib/worktrees')

    expect(removeWorktrees).toHaveBeenCalledTimes(1)
    expect(vi.mocked(removeWorktrees).mock.calls[0]?.[0].branches).toEqual(['release/v1.2.5'])
  })
})

describe('worktrees-remove target validation (all-or-nothing)', () => {
  it('errors when a versions target is not an active worktree, before removing anything', async () => {
    await expect(worktreesRemove({ confirmedCommand: true, versions: '9.9.9' })).rejects.toThrow(
      /unmatched worktree target/,
    )

    const { removeWorktrees } = await import('src/lib/worktrees')

    expect(removeWorktrees).not.toHaveBeenCalled()
  })

  it('errors if ANY of several targets is unmatched, removing none (all-or-nothing)', async () => {
    // 1.2.5 exists; 9.9.9 does not — the whole batch must be rejected.
    await expect(worktreesRemove({ confirmedCommand: true, versions: '1.2.5, 9.9.9' })).rejects.toThrow(
      /release\/v9\.9\.9/,
    )

    const { removeWorktrees } = await import('src/lib/worktrees')

    expect(removeWorktrees).not.toHaveBeenCalled()
  })
})

describe('worktrees-remove MCP tool surface', () => {
  it('does not advertise all in its MCP input schema', () => {
    expect(Object.keys(worktreesRemoveMcpTool.inputSchema)).toEqual(['versions'])
  })

  it('warns in its description that gitignored local state (incl. .env) is deleted', () => {
    const { description } = worktreesRemoveMcpTool

    expect(description).toMatch(/gitignored/i)
    expect(description).toMatch(/\.env/)
    expect(description).toMatch(/all=true/)
  })
})
