import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRs } from 'src/integrations/gh'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'

import { worktreesSync } from '../worktrees-sync'

// Real `getInfraKitConfig`: git-utils points at a config-less tmpdir so the hoisted read throws the
// REAL Step 4 message. The destructive path (git worktree remove) is reached only via
// getCurrentWorktrees + getReleasePRs + closeCmuxWorkspaceByCwd — all spied as tripwires.
vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getMainRepoRoot: vi.fn(),
    getCurrentWorktrees: vi.fn(),
    // The shared removeWorktrees checks registration via listWorktrees after a rejected removal.
    listWorktrees: vi.fn(),
  }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRs: vi.fn() }
})

vi.mock('src/integrations/cmux', () => {
  return { closeCmuxWorkspaceByCwd: vi.fn() }
})

vi.mock('src/integrations/ide', () => {
  return { removeIdeWorktreeFolders: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

let tmp: string
let homedirSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.clearAllMocks()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sync-guard-'))

  const { getProjectRoot, getMainRepoRoot } = await import('src/lib/git-utils')

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getMainRepoRoot).mockResolvedValue(tmp)
  vi.mocked(getCurrentWorktrees).mockResolvedValue([])
  vi.mocked(getReleasePRs).mockResolvedValue([])
  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)
  resetInfraKitConfigCache()
})

afterEach(() => {
  homedirSpy.mockRestore()
  resetInfraKitConfigCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('worktrees sync — config-read guard', () => {
  // Test 5 (side-effect): nothing in the destructive path runs.
  it('never lists worktrees or fetches release PRs when the project config is missing', async () => {
    await expect(worktreesSync({ confirmedCommand: true })).rejects.toThrow()

    expect(getCurrentWorktrees).not.toHaveBeenCalled()
    expect(getReleasePRs).not.toHaveBeenCalled()
  })

  // Test 6 (message): the plain Error survives the try/catch rewrap (placement above try).
  it('rejects with the real "infra-kit.json not found at" message (not the generic rewrap)', async () => {
    const err = await worktreesSync({ confirmedCommand: true }).catch((e: unknown) => {
      return e
    })

    expect((err as Error).message).toContain('infra-kit.json not found at')
  })

  // Test 7 (ordering): assertManagementContext runs BEFORE the config read (§3.2).
  it('surfaces the assertManagementContext failure before the config read (management-context first)', async () => {
    vi.mocked(assertManagementContext).mockRejectedValue(
      new Error('run this from the main repository checkout, not a linked git worktree'),
    )

    await expect(worktreesSync({ confirmedCommand: true })).rejects.toThrow(/main repository checkout/)

    expect(getCurrentWorktrees).not.toHaveBeenCalled()
  })
})
