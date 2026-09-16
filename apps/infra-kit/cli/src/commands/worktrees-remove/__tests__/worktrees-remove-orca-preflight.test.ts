import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { orcaCallerInsideTargets } from 'src/integrations/orca'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getProjectRoot } from 'src/lib/git-utils'
import { removeWorktrees } from 'src/lib/worktrees'

import { worktreesRemove } from '../worktrees-remove'

/**
 * The `orca_caller_inside_target` preflight (docs/orca-migration-plan.md §2.1, §2.4): a removal
 * run from an Orca terminal inside one of its targets is refused BEFORE the confirm and before any
 * git call — for the WHOLE batch, not only the branch the caller sits in.
 *
 * @example
 * await worktreesRemove({ confirmedCommand: false, versions: '1.2.5, 1.2.6' }) // → refused, 0 git calls
 */

const CURRENT_WORKTREES = ['release/v1.2.5', 'release/v1.2.6']
const PROJECT_ROOT = '/workspace/project-root'
const WORKTREE_DIR = `${PROJECT_ROOT}-worktrees`

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { getCurrentWorktrees: vi.fn(), getProjectRoot: vi.fn() }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/lib/prompts/release-picker', () => {
  return { pickReleaseBranches: vi.fn() }
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

vi.mock('src/integrations/orca', () => {
  return { orcaCallerInsideTargets: vi.fn() }
})

vi.mock('@inquirer/confirm', () => {
  return { default: vi.fn().mockResolvedValue(true) }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  vi.spyOn(commandEcho, 'print').mockImplementation(() => {})
  agentMode.source = null

  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(getCurrentWorktrees).mockResolvedValue(CURRENT_WORKTREES)
  vi.mocked(getProjectRoot).mockResolvedValue(PROJECT_ROOT)
  vi.mocked(removeWorktrees).mockResolvedValue({ removed: [], failed: [] })
  vi.mocked(orcaCallerInsideTargets).mockResolvedValue(null)
})

describe('worktrees remove — the caller sits inside a target', () => {
  it('refuses orca_caller_inside_target before the confirm and removes NOTHING of the batch', async () => {
    vi.mocked(orcaCallerInsideTargets).mockResolvedValue(`${WORKTREE_DIR}/release/v1.2.6`)

    const error = await worktreesRemove({ confirmedCommand: false, versions: '1.2.5, 1.2.6' }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'refused',
      reason: 'orca_caller_inside_target',
    })
    expect((error as StructuredRefusalError).exitCode).toBe(2)
    expect((error as StructuredRefusalError).message).toContain(
      `re-run from a terminal that is not an Orca pane of ${WORKTREE_DIR}/release/v1.2.6`,
    )
    expect((error as StructuredRefusalError).message).not.toMatch(/\bcd\b|-C\b/)

    // Checked against the WHOLE batch, once.
    expect(orcaCallerInsideTargets).toHaveBeenCalledTimes(1)
    expect(orcaCallerInsideTargets).toHaveBeenCalledWith([
      `${WORKTREE_DIR}/release/v1.2.5`,
      `${WORKTREE_DIR}/release/v1.2.6`,
    ])
    // Before the confirm, before git — for v1.2.5 as much as for v1.2.6.
    expect(confirm).not.toHaveBeenCalled()
    expect(removeWorktrees).not.toHaveBeenCalled()
  })

  it('carries the agent source in the payload under agent mode', async () => {
    agentMode.source = 'flag'
    vi.mocked(orcaCallerInsideTargets).mockResolvedValue(`${WORKTREE_DIR}/release/v1.2.5`)

    const error = await worktreesRemove({ confirmedCommand: true, versions: '1.2.5' }).catch((e: unknown) => {
      return e
    })

    expect((error as StructuredRefusalError).structuredContent).toMatchObject({ agentMode: 'flag' })
    expect(removeWorktrees).not.toHaveBeenCalled()
  })
})

describe('worktrees remove — the caller is elsewhere', () => {
  it('proceeds to the confirm and the removal', async () => {
    await worktreesRemove({ confirmedCommand: false, versions: '1.2.5' })

    expect(orcaCallerInsideTargets).toHaveBeenCalledWith([`${WORKTREE_DIR}/release/v1.2.5`])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(removeWorktrees).toHaveBeenCalledTimes(1)
  })
})
