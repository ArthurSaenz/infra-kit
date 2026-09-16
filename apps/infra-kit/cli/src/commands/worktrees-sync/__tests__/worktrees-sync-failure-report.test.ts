import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { getReleasePRs } from 'src/integrations/gh'
import { removeIdeWorktreeFolders } from 'src/integrations/ide'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getProjectRoot } from 'src/lib/git-utils'
import { removeWorktrees } from 'src/lib/worktrees'

import { worktreesSync, worktreesSyncMcpTool } from '../worktrees-sync'

/**
 * worktrees-sync used to carry its OWN copy of the removal loop and its own "No unused worktrees to
 * remove" line, so the shared recovery/report never reached it. It now consumes the shared
 * `removeWorktrees` and reports failures the same way worktrees-remove does.
 */

const PROJECT_ROOT = '/workspace/project-root'

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { getCurrentWorktrees: vi.fn(), getProjectRoot: vi.fn(), listWorktrees: vi.fn() }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/lib/worktrees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/worktrees')>()

  return { ...actual, removeWorktrees: vi.fn() }
})

vi.mock('src/integrations/ide', () => {
  return { removeIdeWorktreeFolders: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRs: vi.fn() }
})

vi.mock('@inquirer/confirm', () => {
  return { default: vi.fn().mockResolvedValue(true) }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const STALE_FAILURE = {
  removed: [],
  failed: [{ branch: 'release/v1.2.5', reason: 'fatal: contains modified or untracked files' }],
}

const outputSchema = z.object(worktreesSyncMcpTool.outputSchema)

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()

  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  // One release worktree with no open PR → exactly one stale branch to remove.
  vi.mocked(getCurrentWorktrees).mockResolvedValue(['release/v1.2.5'])
  vi.mocked(getReleasePRs).mockResolvedValue([])
  vi.mocked(getProjectRoot).mockResolvedValue(PROJECT_ROOT)
  agentMode.source = null
  vi.mocked(removeWorktrees).mockResolvedValue({ removed: [], failed: [] })
  vi.mocked(removeIdeWorktreeFolders).mockResolvedValue([])
})

describe('worktrees-sync failure report', () => {
  it('uses the shared removal with projectRoot', async () => {
    await worktreesSync({ confirmedCommand: true })

    expect(removeWorktrees).toHaveBeenCalledTimes(1)
    expect(vi.mocked(removeWorktrees).mock.calls[0]?.[0]).toMatchObject({
      branches: ['release/v1.2.5'],
      projectRoot: PROJECT_ROOT,
    })
  })

  it('cLI: throws an OperationError naming the branch, without the remote-connectivity rewrap', async () => {
    vi.mocked(removeWorktrees).mockResolvedValue(STALE_FAILURE)

    let thrown: unknown

    try {
      await worktreesSync({ confirmedCommand: true })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(OperationError)
    expect((thrown as Error).message).toMatch(/release\/v1\.2\.5/)
    expect((thrown as Error).message).not.toMatch(/gh auth status/)
    expect(removeIdeWorktreeFolders).toHaveBeenCalledTimes(1)
  })

  // The handler THROWS on the agent surface; it is the tool handler (`lib/tool-handler`) that renders
  // a `StructuredRefusalError` as an `isError` result, and `entry/cli.ts` that emits it under `--json`.
  // What must hold here is that the throw carries the schema-valid payload and survives this
  // handler's own `catch` — which rewraps anything that is not an `OperationError`.
  it('agent: throws a partial_failure refusal carrying a schema-valid failedWorktrees', async () => {
    agentMode.source = 'flag'
    vi.mocked(removeWorktrees).mockResolvedValue(STALE_FAILURE)

    const thrown = await worktreesSync({ confirmedCommand: true }).catch((error: unknown) => {
      return error
    })

    expect(thrown).toBeInstanceOf(StructuredRefusalError)

    const { structuredContent, exitCode } = thrown as StructuredRefusalError

    expect(exitCode).toBe(1)
    expect(structuredContent).toEqual({
      status: 'partial_failure',
      removedWorktrees: [],
      failedWorktrees: ['release/v1.2.5'],
      count: 0,
    })
    expect(() => {
      return outputSchema.parse(structuredContent)
    }).not.toThrow()
  })

  it('declares failedWorktrees in the tool output schema', () => {
    expect(Object.keys(worktreesSyncMcpTool.outputSchema)).toEqual(['removedWorktrees', 'failedWorktrees', 'count'])
  })

  // Same handler, same rewrapping `catch`: the confirm site's `confirmation_required` must come out
  // intact and BEFORE any removal.
  it('an unconfirmed agent run throws confirmation_required un-rewrapped and removes nothing', async () => {
    agentMode.source = 'flag'

    const thrown = await worktreesSync({ confirmedCommand: false }).catch((error: unknown) => {
      return error
    })

    expect(thrown).toBeInstanceOf(StructuredRefusalError)
    expect((thrown as StructuredRefusalError).structuredContent).toMatchObject({ status: 'confirmation_required' })
    expect((thrown as StructuredRefusalError).exitCode).toBe(2)
    expect(removeWorktrees).not.toHaveBeenCalled()
  })
})
