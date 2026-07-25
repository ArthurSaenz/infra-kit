import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { mcpMode } from 'src/lib/mcp-mode'
import { removeWorktrees } from 'src/lib/worktrees'

import { worktreesRemove } from '../worktrees-remove'

// Real `getInfraKitConfig`: git-utils points at a config-less tmpdir so the hoisted read throws the
// REAL Step 4 message. assertManagementContext / removeWorktrees are spies for ordering + side-effect
// assertions; isMcpMode reads the real mcpMode holder (toggled per test).
vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getMainRepoRoot: vi.fn(),
    getCurrentWorktrees: vi.fn(),
  }
})

vi.mock('src/lib/worktrees', () => {
  return { removeWorktrees: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

let tmp: string
let homedirSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.clearAllMocks()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-remove-guard-'))

  const { getProjectRoot, getMainRepoRoot } = await import('src/lib/git-utils')

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getMainRepoRoot).mockResolvedValue(tmp)
  vi.mocked(getCurrentWorktrees).mockResolvedValue([])
  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(removeWorktrees).mockResolvedValue([])
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)
  mcpMode.enabled = false
  resetInfraKitConfigCache()
})

afterEach(() => {
  homedirSpy.mockRestore()
  mcpMode.enabled = false
  resetInfraKitConfigCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('worktrees remove — config-read guard', () => {
  // Test 5 (side-effect).
  it('removes nothing and never lists worktrees when the project config is missing', async () => {
    await expect(worktreesRemove({ confirmedCommand: true, versions: '1.2.3' })).rejects.toThrow()

    expect(getCurrentWorktrees).not.toHaveBeenCalled()
    expect(removeWorktrees).not.toHaveBeenCalled()
  })

  // Test 6 (message): the plain Error must survive the command's try/catch rewrap (placement above try).
  it('rejects with the real "infra-kit.json not found at" message (not the generic rewrap)', async () => {
    const err = await worktreesRemove({ confirmedCommand: true, versions: '1.2.3' }).catch((e: unknown) => {
      return e
    })

    expect((err as Error).message).toContain('infra-kit.json not found at')
  })

  // Test 7 (ordering) — assertManagementContext runs BEFORE the config read, so a linked-worktree
  // caller still gets the worktree advice (§3.2) rather than the "not an infra-kit project" message.
  it('surfaces the assertManagementContext failure before the config read (management-context first)', async () => {
    vi.mocked(assertManagementContext).mockRejectedValue(
      new Error('run this from the main repository checkout, not a linked git worktree'),
    )

    await expect(worktreesRemove({ confirmedCommand: true, versions: '1.2.3' })).rejects.toThrow(
      /main repository checkout/,
    )

    expect(getCurrentWorktrees).not.toHaveBeenCalled()
  })

  // Test 7 (pin) — the config read runs BEFORE assertMcpRemovalInput: in MCP mode with no `versions`,
  // "not an infra-kit project" wins over "versions is required".
  it('reports the missing config before the MCP versions-required validation', async () => {
    mcpMode.enabled = true

    const err = await worktreesRemove({ confirmedCommand: true }).catch((e: unknown) => {
      return e
    })

    expect((err as Error).message).toContain('infra-kit.json not found at')
    expect((err as Error).message).not.toContain('requires "versions"')
  })
})
