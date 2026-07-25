import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getCurrentWorktrees } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'

import { worktreesList } from '../worktrees-list'

// Real `getInfraKitConfig`: git-utils is pointed at a config-less tmpdir so the command's hoisted
// config read throws the REAL Step 4 message (test 6). getCurrentWorktrees is a spy so the
// side-effect assertion (test 5) proves the read precedes it.
vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getMainRepoRoot: vi.fn(),
    getCurrentWorktrees: vi.fn(),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

let tmp: string
let homedirSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.clearAllMocks()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-list-guard-'))

  const { getProjectRoot, getMainRepoRoot } = await import('src/lib/git-utils')

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getMainRepoRoot).mockResolvedValue(tmp)
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)
  resetInfraKitConfigCache()
})

afterEach(() => {
  homedirSpy.mockRestore()
  resetInfraKitConfigCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('worktrees list — config-read guard', () => {
  // Test 5 (side-effect): the guard's real defence.
  it('never calls getCurrentWorktrees when the project config is missing', async () => {
    await expect(worktreesList()).rejects.toThrow()

    expect(getCurrentWorktrees).not.toHaveBeenCalled()
  })

  // Test 6 (message): the plain Error propagates unchanged (no try in this function).
  it('rejects with the real "infra-kit.json not found at" message', async () => {
    const err = await worktreesList().catch((e: unknown) => {
      return e
    })

    expect((err as Error).message).toContain('infra-kit.json not found at')
  })
})
