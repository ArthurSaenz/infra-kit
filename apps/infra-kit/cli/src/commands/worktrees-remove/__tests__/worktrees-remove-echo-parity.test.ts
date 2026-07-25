import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { commandEcho } from 'src/lib/command-echo'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { pickReleaseBranches } from 'src/lib/prompts/release-picker'

import { worktreesRemove } from '../worktrees-remove'

/**
 * `commandEcho` parity guard for the interactive `--all` vs `--versions`
 * derivation in `worktrees-remove`. The 7 migrated call sites preserve the
 * `setInteractive()` / `addOption()` ordering purely by executor discipline —
 * nothing else guards it. This test pins the derivation:
 *   - picker returns EVERY current worktree      → echo records `--all true`
 *   - picker returns a STRICT SUBSET of worktrees → echo records `--versions <labels>`
 *
 * `releaseBranchLabels` stays REAL so the `<labels>` value is derived exactly as
 * in production; only side-effecting collaborators are mocked.
 */

const CURRENT_WORKTREES = ['release/v1.2.5', 'release/v1.2.6']

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { getCurrentWorktrees: vi.fn(), getProjectRoot: vi.fn(), getRepoName: vi.fn() }
})

// worktreesRemove now reads project config before its work (fail-honestly guard). Mock it so these
// echo-parity tests exercise the derivation, not config resolution.
vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
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

// Keep `releaseBranchLabels`/`formatBranchPickerItems` real; only stub the Jira lookup.
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

let addOptionSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.clearAllMocks()
  commandEcho.reset()
  addOptionSpy = vi.spyOn(commandEcho, 'addOption')

  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(getCurrentWorktrees).mockResolvedValue(CURRENT_WORKTREES)
  vi.mocked(getProjectRoot).mockResolvedValue('/workspace/project-root')
  vi.mocked(getRepoName).mockResolvedValue('repo')
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])

  const { removeWorktrees } = await import('src/lib/worktrees')

  vi.mocked(removeWorktrees).mockResolvedValue([])

  const { removeIdeWorktreeFolders } = await import('src/integrations/ide')

  vi.mocked(removeIdeWorktreeFolders).mockResolvedValue([])
})

afterEach(() => {
  addOptionSpy.mockRestore()
  commandEcho.reset()
})

describe('worktrees-remove commandEcho parity', () => {
  it('records `--all true` when the picker returns every current worktree', async () => {
    // confirmedCommand:true bypasses the confirm prompt and the interactive `--yes`
    // addOption, so the ONLY addOption call is the `--all`/`--versions` derivation.
    vi.mocked(pickReleaseBranches).mockResolvedValue([...CURRENT_WORKTREES])

    await worktreesRemove({ confirmedCommand: true })

    expect(addOptionSpy).toHaveBeenCalledTimes(1)
    expect(addOptionSpy).toHaveBeenCalledWith('--all', true)
  })

  it('records `--versions <labels>` when the picker returns a strict subset', async () => {
    vi.mocked(pickReleaseBranches).mockResolvedValue(['release/v1.2.5'])

    await worktreesRemove({ confirmedCommand: true })

    expect(addOptionSpy).toHaveBeenCalledTimes(1)
    expect(addOptionSpy).toHaveBeenCalledWith('--versions', ['1.2.5'])
  })
})
