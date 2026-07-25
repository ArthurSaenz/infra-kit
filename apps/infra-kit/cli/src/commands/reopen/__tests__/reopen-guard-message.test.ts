import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectRoot } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'

import { reopenCurrentProject } from '../reopen'

// Real `getInfraKitConfig` (test 6): git-utils points at a config-less tmpdir so the REAL Step 4 throw
// fires. Because the read sits ABOVE reopen's try, the plain Error propagates verbatim — a read inside
// the try would be rewrapped by buildMessage and the "not found" text silently dropped (§0.4). This is
// the §0.4 rewrap regression net; kept SEPARATE from the side-effect file (different config strategy).
vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn(), getMainRepoRoot: vi.fn(), listWorktrees: vi.fn() }
})

vi.mock('src/integrations/ide', async (importActual) => {
  const actual = await importActual<typeof import('src/integrations/ide')>()

  return { ...actual, openIdeWorkspace: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

let tmp: string
let homedirSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.clearAllMocks()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-guard-msg-'))

  const { getMainRepoRoot, listWorktrees } = await import('src/lib/git-utils')

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getMainRepoRoot).mockResolvedValue(tmp)
  vi.mocked(listWorktrees).mockResolvedValue([])
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)
  resetInfraKitConfigCache()
})

afterEach(() => {
  homedirSpy.mockRestore()
  resetInfraKitConfigCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('reopen — config-read guard (message)', () => {
  it('rejects with the real "infra-kit.json not found at" message, not the generic reopen rewrap', async () => {
    const err = await reopenCurrentProject({}).catch((e: unknown) => {
      return e
    })

    expect((err as Error).message).toContain('infra-kit.json not found at')
    expect((err as Error).message).not.toContain('failed to reopen worktrees')
  })
})
