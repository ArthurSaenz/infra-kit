import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentMode } from 'src/lib/agent-mode'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { removeWorktrees } from 'src/lib/worktrees'

import { worktreesRemove } from '../worktrees-remove'

// Real `getInfraKitConfig`: git-utils points at a config-less tmpdir so the hoisted read throws the
// REAL Step 4 message. assertManagementContext / removeWorktrees are spies for ordering + side-effect
// assertions; isAgentMode reads the real agentMode holder (toggled per test).
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

vi.mock('src/lib/worktrees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/worktrees')>()

  return { ...actual, removeWorktrees: vi.fn() }
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
  vi.mocked(removeWorktrees).mockResolvedValue({ removed: [], failed: [] })
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)
  agentMode.source = null
  resetInfraKitConfigCache()
})

afterEach(() => {
  homedirSpy.mockRestore()
  agentMode.source = null
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
    agentMode.source = 'mcp'

    const err = await worktreesRemove({ confirmedCommand: true }).catch((e: unknown) => {
      return e
    })

    expect((err as Error).message).toContain('infra-kit.json not found at')
    expect((err as Error).message).not.toContain('requires "versions"')
  })
})

/** A minimal valid project config, so the config-read guard passes and the input guard is reached. */
const writeProjectConfig = (): void => {
  fs.writeFileSync(
    path.join(tmp, 'infra-kit.json'),
    JSON.stringify({ envManagement: { provider: 'doppler', config: { name: 'my-project' } } }),
  )
  resetInfraKitConfigCache()
}

describe('worktrees remove — a Bash-driven agent reads CLI wording, not MCP wording', () => {
  // Same guard as the MCP suite pins; only the wording forks on `agentMode.source === 'mcp'`. The
  // config read wins first, so the refusal here is asserted THROUGH a present config.
  it('--all under --agent: refused, naming --versions and "under agent mode"', async () => {
    writeProjectConfig()
    agentMode.source = 'flag'

    const err = await worktreesRemove({ confirmedCommand: true, all: true }).catch((e: unknown) => {
      return e
    })

    expect((err as Error).message).toContain('--all is not permitted for worktrees remove under agent mode')
    expect((err as Error).message).toContain('--versions <refs>')
    expect((err as Error).message).not.toContain('over MCP')
    expect((err as Error).message).not.toContain('all=true')
  })

  it('no --versions under --agent: argument_required naming --versions with the list command', async () => {
    writeProjectConfig()
    agentMode.source = 'flag'

    const err = await worktreesRemove({ confirmedCommand: true }).catch((e: unknown) => {
      return e
    })

    expect((err as Error).message).toContain('worktrees remove under agent mode requires --versions')
    expect((err as Error).message).toContain('`infra-kit worktrees list --json`')
    expect((err as Error).message).not.toContain('needs a TTY')
  })
})
