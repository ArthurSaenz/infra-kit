import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getProjectRoot, getRepoName } from 'src/lib/git-utils'

import { worktreesRemove, worktreesRemoveMcpTool } from '../worktrees-remove'

/**
 * Guards that make `worktrees-remove` safe to drive under `--agent`:
 *   - an explicit, matching `versions` is the one accepted shape (the `--all` refusal and the
 *     `--versions`-required refusal are pinned in `worktrees-remove-guard.test.ts`)
 *   - a `versions` value that names a non-existent worktree errors BEFORE removing anything, on both
 *     the human and agent paths (today `removeWorktrees`' allSettled would swallow it as a no-op success)
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

// worktreesRemove now reads project config before its work (fail-honestly guard). Mock it so these
// guard tests exercise the agent/validation logic, not config resolution.
vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/lib/prompts/release-picker', () => {
  return { pickReleaseBranch: vi.fn(), pickReleaseBranches: vi.fn() }
})

vi.mock('src/lib/worktrees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/worktrees')>()

  return { ...actual, removeWorktrees: vi.fn() }
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
  agentMode.source = null

  const { removeWorktrees } = await import('src/lib/worktrees')

  vi.mocked(removeWorktrees).mockResolvedValue({ removed: [], failed: [] })

  const { removeIdeWorktreeFolders } = await import('src/integrations/ide')

  vi.mocked(removeIdeWorktreeFolders).mockResolvedValue([])
})

describe('worktrees-remove agent guards', () => {
  it('allows an explicit, matching versions target under --agent', async () => {
    agentMode.source = 'flag'

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

describe('worktrees-remove command description', () => {
  it('warns in its description that gitignored local state (incl. .env) is deleted', () => {
    const { description } = worktreesRemoveMcpTool

    expect(description).toMatch(/gitignored/i)
    expect(description).toMatch(/\.env/)
    expect(description).toMatch(/all=true/)
  })
})
