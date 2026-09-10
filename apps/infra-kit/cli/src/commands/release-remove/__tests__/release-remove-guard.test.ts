import confirm from '@inquirer/confirm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeJiraVersion } from 'src/integrations/jira/remove-version'
import { commandEcho } from 'src/lib/command-echo'
import { CommandDeclinedError } from 'src/lib/errors/command-declined-error'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertBaseBranchSwitchable, assertManagementContext } from 'src/lib/git-guard'
import {
  deleteLocalBranch,
  deleteRemoteBranch,
  getCurrentWorktrees,
  getMainRepoRoot,
  getProjectRoot,
  getRepoName,
} from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { mcpMode } from 'src/lib/mcp-mode'
import { removeReleaseWorktreeIfPresent } from 'src/lib/worktrees/remove-release-worktree'

import { releaseRemove } from '../release-remove'
import { LABEL, installDefaults } from './release-remove-mocks'

/**
 * @fileoverview
 * The guard prologue, and the decline — mirroring `worktrees-remove-guard.test.ts`.
 *
 * Three orderings are load-bearing and none of them is expressed anywhere but the order of the
 * statements themselves, so nothing else would fail if they were reshuffled:
 *   - `assertManagementContext` runs FIRST, so an operator standing inside the release’s own linked
 *     worktree is told to move rather than told this is not an infra-kit project.
 *   - `getInfraKitConfig()` is read ABOVE the try whose catch rewraps, so its plain `Error` reaches
 *     the operator with its real text instead of the generic "check gh auth / git worktree / Jira".
 *   - `assertBaseBranchSwitchable` runs BEFORE the confirm, so the operator is not asked to approve a
 *     teardown that cannot switch off the branch it is about to delete.
 *
 * The config module is kept REAL here (git-utils points at a config-less tmpdir) so the missing-config
 * message under test is the one production throws, not a fixture.
 *
 * The decline is the other half, and it names its own false-success: `confirmOrExit`’s DEFAULT is
 * `process.exit(0)`, which would make "the operator said no" indistinguishable from "already fully
 * removed, every step skipped" — same exit code, same absence of mutations. An operator scripting
 * `release remove && …` would then proceed as though a release had been torn down. The command opts
 * into `throwOnDecline`, so a decline must arrive as a `CommandDeclinedError` with nothing mutated.
 */

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()
  const { zxCommandMock } = await import('src/lib/git-utils/__tests__/zx-command-mock')

  return {
    ...actual,
    $: zxCommandMock(() => {
      return { stdout: '' }
    }),
  }
})

vi.mock('src/lib/git-guard', () => {
  return { assertBaseBranchSwitchable: vi.fn(), assertManagementContext: vi.fn() }
})

// `getMainRepoRoot`/`getRepoName` are here for the REAL config module, which resolves its layer-1 and
// layer-3 paths through them.
vi.mock('src/lib/git-utils', () => {
  return {
    branchExists: vi.fn(),
    deleteLocalBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    getCurrentBranch: vi.fn(),
    getCurrentWorktrees: vi.fn(),
    getMainRepoRoot: vi.fn(),
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    lsRemoteHead: vi.fn(),
    revParseVerify: vi.fn(),
  }
})

vi.mock('src/lib/prompts/release-picker', () => {
  return { pickReleaseBranch: vi.fn() }
})

vi.mock('src/lib/worktrees/remove-release-worktree', () => {
  return { removeReleaseWorktreeIfPresent: vi.fn() }
})

vi.mock('src/integrations/cmux', () => {
  return { listCmuxWorkspacesByCwd: vi.fn(), realpathForCmuxCwd: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/integrations/gh/pr-status', () => {
  return { fetchPRByHead: vi.fn() }
})

vi.mock('src/integrations/ide', () => {
  return { removeIdeWorktreeFolders: vi.fn() }
})

vi.mock('src/integrations/jira', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/jira')>()

  return { ...actual, findVersionByName: vi.fn(), loadJiraConfigOptional: vi.fn() }
})

vi.mock('src/integrations/jira/remove-version', () => {
  return { getVersionRelatedIssueCounts: vi.fn(), removeJiraVersion: vi.fn() }
})

vi.mock('src/lib/release-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/release-utils')>()

  return { ...actual, getJiraDescriptions: vi.fn() }
})

vi.mock('@inquirer/confirm', () => {
  return { default: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }
})

const VALID_CONFIG = JSON.stringify({ envManagement: { provider: 'doppler', config: { name: 'my-project' } } })

let tmp: string
let homedirSpy: ReturnType<typeof vi.spyOn>

const writeProjectConfig = (): void => {
  fs.writeFileSync(path.join(tmp, 'infra-kit.json'), VALID_CONFIG)
  resetInfraKitConfigCache()
}

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-remove-guard-'))

  installDefaults()
  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getMainRepoRoot).mockResolvedValue(tmp)
  vi.mocked(getRepoName).mockResolvedValue('repo')
  vi.mocked(confirm).mockResolvedValue(true)

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

describe('release remove — guard prologue ordering', () => {
  it('surfaces the management-context refusal before the config is read', async () => {
    // The REAL guard throws an `OperationError` (`git-guard.ts:149-153`), and this one runs ABOVE the
    // try, so its text reaches the operator either way. Shaped faithfully anyway: a plain `Error` here
    // would be asserting the generic-wrap path while claiming to assert the refusal.
    vi.mocked(assertManagementContext).mockRejectedValue(
      new OperationError(undefined, {
        operation: 'remove a release',
        remediation: 'run this from the main repository checkout, not a linked git worktree',
        stderrExcerpt: 'command run from inside a linked worktree',
      }),
    )

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('main repository checkout')
    expect((error as Error).message).toContain('command run from inside a linked worktree')
    // If the config read had come first, THIS is the message that would have won instead.
    expect((error as Error).message).not.toContain('infra-kit.json not found at')
    expect(getCurrentWorktrees).not.toHaveBeenCalled()
  })

  it('reports the real missing-config message, un-rewrapped by the command catch', async () => {
    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('infra-kit.json not found at')
    expect((error as Error).message).not.toContain('check `gh auth status`')
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })

  it('refuses an unswitchable base branch before asking the operator to confirm', async () => {
    writeProjectConfig()
    // The REAL guard throws an `OperationError`, which the command passes through un-rewrapped; a
    // plain `Error` here would be testing the generic catch instead of the ordering.
    vi.mocked(assertBaseBranchSwitchable).mockRejectedValue(
      new OperationError(undefined, {
        operation: `remove release ${LABEL}`,
        remediation: 'close or remove that worktree, or run the release from it',
        stderrExcerpt: 'base branch "dev" is checked out in the worktree at /workspace/other',
      }),
    )

    await expect(releaseRemove({ confirmedCommand: false, version: LABEL })).rejects.toThrow(
      /checked out in the worktree/,
    )

    expect(confirm).not.toHaveBeenCalled()
    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  })
})

describe('release remove — a declined confirm', () => {
  it('throws CommandDeclinedError instead of exiting 0 like a fully-skipped success', async () => {
    writeProjectConfig()
    vi.mocked(confirm).mockResolvedValue(false)

    const error = await releaseRemove({ confirmedCommand: false, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(CommandDeclinedError)
    expect((error as Error).message).toBe('Operation cancelled by the operator')
  })

  it('mutates nothing on the decline', async () => {
    writeProjectConfig()
    vi.mocked(confirm).mockResolvedValue(false)

    await expect(releaseRemove({ confirmedCommand: false, version: LABEL })).rejects.toBeInstanceOf(
      CommandDeclinedError,
    )

    expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
    expect(deleteLocalBranch).not.toHaveBeenCalled()
    expect(deleteRemoteBranch).not.toHaveBeenCalled()
    expect(removeJiraVersion).not.toHaveBeenCalled()
  })

  it('is not rewrapped as an operation failure on the way out', async () => {
    writeProjectConfig()
    vi.mocked(confirm).mockResolvedValue(false)

    const error = await releaseRemove({ confirmedCommand: false, version: LABEL }).catch((e: unknown) => {
      return e
    })

    // `entry/cli.ts` renders this text at exit 1; a generic rewrap would bury it under "failed to
    // remove a release" and lose the distinction from a real failure.
    expect((error as Error).message).not.toContain('failed to remove a release')
  })
})
