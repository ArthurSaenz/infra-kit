import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { removeIdeWorktreeFolders } from 'src/integrations/ide'
import { commandEcho } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { isMcpMode } from 'src/lib/mcp-mode'
import { removeWorktrees } from 'src/lib/worktrees'

import { worktreesRemove, worktreesRemoveMcpTool } from '../worktrees-remove'

/**
 * A removal git refused used to be reported as "No unused worktrees to remove" with exit 0 and
 * `count: 0` — the exact false-success that hid the ENOTEMPTY race. These tests pin the truthful
 * report on both surfaces:
 *   - CLI: an OperationError naming the branch, thrown AFTER the IDE cleanup and the echo line
 *   - MCP: a resolved result with `isError: true` and a schema-valid `failedWorktrees`
 *
 * `removeWorktrees` is mocked (its recovery logic has its own unit tests); the reporting helpers
 * from src/lib/worktrees stay real.
 */

const CURRENT_WORKTREES = ['release/v1.2.5', 'release/v1.2.6']
const PROJECT_ROOT = '/workspace/project-root'

vi.mock('src/lib/config-bootstrap', () => {
  return { ensureUserProjectConfig: vi.fn(async () => {}), seedUserProjectConfig: vi.fn() }
})

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { getCurrentWorktrees: vi.fn(), getProjectRoot: vi.fn(), getRepoName: vi.fn() }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/lib/mcp-mode', () => {
  return { isMcpMode: vi.fn() }
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

const PARTIAL_FAILURE = {
  removed: ['release/v1.2.5'],
  failed: [{ branch: 'release/v1.2.6', reason: 'fatal: contains modified or untracked files' }],
}

const outputSchema = z.object(worktreesRemoveMcpTool.outputSchema)

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()

  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(getCurrentWorktrees).mockResolvedValue(CURRENT_WORKTREES)
  vi.mocked(getProjectRoot).mockResolvedValue(PROJECT_ROOT)
  vi.mocked(getRepoName).mockResolvedValue('repo')
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])
  vi.mocked(isMcpMode).mockReturnValue(false)
  vi.mocked(removeWorktrees).mockResolvedValue({ removed: [], failed: [] })
  vi.mocked(removeIdeWorktreeFolders).mockResolvedValue([])
})

describe('worktrees-remove failure report — CLI path', () => {
  it('throws an OperationError naming the branch git refused, after IDE cleanup and the echo line', async () => {
    vi.mocked(removeWorktrees).mockResolvedValue(PARTIAL_FAILURE)

    const printSpy = vi.spyOn(commandEcho, 'print')

    let thrown: unknown

    try {
      await worktreesRemove({ confirmedCommand: true, versions: '1.2.5, 1.2.6' })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(OperationError)
    expect((thrown as Error).message).toMatch(/release\/v1\.2\.6/)
    expect((thrown as Error).message).toMatch(/modified or untracked/)

    // The successful half of the batch was still cleaned up in the IDE and echoed.
    expect(removeIdeWorktreeFolders).toHaveBeenCalledTimes(1)
    expect(vi.mocked(removeIdeWorktreeFolders).mock.calls[0]?.[0].removedWorktrees).toEqual(['release/v1.2.5'])
    expect(printSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(removeIdeWorktreeFolders).mock.invocationCallOrder[0]).toBeLessThan(
      printSpy.mock.invocationCallOrder[0] as number,
    )
  })

  it('passes projectRoot to the shared removal so it can ask git about registration', async () => {
    await worktreesRemove({ confirmedCommand: true, versions: '1.2.5' })

    expect(vi.mocked(removeWorktrees).mock.calls[0]?.[0].projectRoot).toBe(PROJECT_ROOT)
  })

  it('returns failedWorktrees: [] on success', async () => {
    vi.mocked(removeWorktrees).mockResolvedValue({ removed: ['release/v1.2.5'], failed: [] })

    const result = await worktreesRemove({ confirmedCommand: true, versions: '1.2.5' })

    expect(result.structuredContent).toEqual({ removedWorktrees: ['release/v1.2.5'], failedWorktrees: [], count: 1 })
    expect(result.isError).toBeUndefined()
    expect(() => {
      return outputSchema.parse(result.structuredContent)
    }).not.toThrow()
  })
})

describe('worktrees-remove failure report — MCP path', () => {
  it('resolves with isError and a schema-valid failedWorktrees instead of throwing', async () => {
    vi.mocked(isMcpMode).mockReturnValue(true)
    vi.mocked(removeWorktrees).mockResolvedValue(PARTIAL_FAILURE)

    const result = await worktreesRemove({ confirmedCommand: true, versions: '1.2.5, 1.2.6' })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      removedWorktrees: ['release/v1.2.5'],
      failedWorktrees: ['release/v1.2.6'],
      count: 1,
    })
    expect(() => {
      return outputSchema.parse(result.structuredContent)
    }).not.toThrow()
    expect(removeIdeWorktreeFolders).toHaveBeenCalledTimes(1)
  })

  it('declares failedWorktrees in the tool output schema', () => {
    expect(Object.keys(worktreesRemoveMcpTool.outputSchema)).toEqual(['removedWorktrees', 'failedWorktrees', 'count'])
  })
})
