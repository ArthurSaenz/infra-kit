import { beforeEach, describe, expect, it, vi } from 'vitest'

import { openIdeWorkspace } from 'src/integrations/ide'
import { getProjectRoot, listWorktrees } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'

import { reopenCurrentProject } from '../reopen'

// getInfraKitConfig is MODULE-MOCKED to reject (REQUIRED): getInfraKitConfigPaths calls getProjectRoot
// itself, so "getProjectRoot@reopenCurrentProject was never invoked" is only sound under this mock —
// against the real config module getProjectRoot IS called by path resolution and the tripwire goes red
// for the wrong reason. This is why unit tests 5 and 6 are kept in SEPARATE files.
vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getInfraKitConfig).mockRejectedValue(
    new Error('infra-kit.json not found at /some/repo/infra-kit.json — this git repo is not an infra-kit project.'),
  )
})

describe('reopen — config-read guard (side effects)', () => {
  // Test 5: the guard's real defence. openIdeWorkspace is deliberately NOT the tripwire (it reads
  // config itself, so it would pass vacuously) — getProjectRoot@:109 and listWorktrees@:117 are.
  it('never resolves the project root or lists worktrees when the config is missing', async () => {
    await expect(reopenCurrentProject({})).rejects.toThrow()

    expect(getProjectRoot).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(openIdeWorkspace).not.toHaveBeenCalled()
  })

  // Test 8: the read precedes the dry-run early return — --dry-run reads no config today, so a read
  // placed at the side-effect site (below the dry-run branch) would leave this path unguarded.
  it('rejects on --dry-run before resolving the project root (guard is above the dry-run branch)', async () => {
    await expect(reopenCurrentProject({ dryRun: true })).rejects.toThrow()

    expect(getProjectRoot).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })
})
