import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { removeJiraVersion } from 'src/integrations/jira/remove-version'
import { OperationError } from 'src/lib/errors/operation-error'
import { pickReleaseBranch } from 'src/lib/prompts/release-picker'
import { removeReleaseWorktreeIfPresent } from 'src/lib/worktrees/remove-release-worktree'

import { releaseRemove } from '../release-remove'
import { installDefaults } from './release-remove-mocks'

/**
 * @fileoverview
 * The picker path — AC-4 and AC-5, which no other file in this suite reaches, because every other
 * test passes `--version` and so never enters target resolution at all.
 *
 * Two false-successes are named here.
 *
 * (1) `assertInteractive`'s refusal is SHARED with three multi-target commands and its remediation
 *     names `--versions` and `--all`. This command accepts neither — Commander rejects them as
 *     unknown flags — so an operator following that text verbatim gets a second, less obvious
 *     failure. `resolveTargetBranch` re-throws with a `--version`-only remediation rather than
 *     editing the shared helper. A test asserting merely "it throws" would pass against the shared
 *     text, so the assertion is that `--versions` and `--all` are ABSENT.
 *
 * (2) The empty-picker case. The plan said to log the `--version` hint; the implementation throws,
 *     because a zero-item Ink picker is a dead end on a TTY — the operator is shown nothing to
 *     select and has no way forward. That deviation was accepted deliberately, and nothing else
 *     pins it: a regression back to "log and continue" would hand `pickReleaseBranch` an empty list
 *     and strand the run rather than failing it.
 *
 * Both cases must also mutate NOTHING — target resolution runs before every guard and before the
 * confirm, so a refusal here that had already touched the worktree would be the worst kind.
 *
 * Mocked: the picker, `getReleasePRsWithInfo`, and every mutating collaborator. Real: the
 * re-throw and refusal logic under test.
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

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/lib/prompts/release-picker', () => {
  return { pickReleaseBranch: vi.fn() }
})

vi.mock('src/lib/worktrees/remove-release-worktree', () => {
  return { removeReleaseWorktreeIfPresent: vi.fn() }
})

vi.mock('src/integrations/orca', () => {
  return { listOrcaTerminals: vi.fn(), orcaCallerInsideTargets: vi.fn() }
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

/**
 * Capture the rejection, and FAIL if the call resolves. A bare `.catch(e => e)` would let a run that
 * succeeded fall through to the `not.toContain` assertions, which a resolved value passes trivially —
 * the test would then be green precisely when the refusal it exists to pin had disappeared.
 */
const rejectionOf = async (run: Promise<unknown>): Promise<Error> => {
  return run.then(
    () => {
      throw new Error('expected release remove to reject, but it resolved')
    },
    (caught: unknown) => {
      return caught as Error
    },
  )
}

const expectNothingMutated = (): void => {
  expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  expect(removeJiraVersion).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  installDefaults()
})

describe('release remove — the picker path', () => {
  it('re-throws a non-interactive refusal naming --version, and never --versions or --all', async () => {
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([{ branch: 'release/v1.2.5', title: 'Release v1.2.5' }] as never)
    // What `assertInteractive` really throws on a non-TTY / --json / MCP run: a shared refusal whose
    // remediation advertises the multi-target flags this command does not accept.
    vi.mocked(pickReleaseBranch).mockRejectedValue(
      new OperationError(undefined, {
        operation: 'interactive branch selection',
        remediation:
          'pass the branch selection explicitly (`--version`/`--versions`/`--all`) for non-interactive, --json, or --agent runs',
      }),
    )

    const error = await rejectionOf(releaseRemove({ confirmedCommand: true }))

    expect(error.message).toContain('--version')
    expect(error.message).not.toContain('--versions')
    expect(error.message).not.toContain('--all')
    expectNothingMutated()
  })

  it('refuses when there is nothing to pick, rather than opening an empty picker', async () => {
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])

    const error = await rejectionOf(releaseRemove({ confirmedCommand: true }))

    // The picker is never reached: an empty list is refused before it can render a dead end.
    expect(pickReleaseBranch).not.toHaveBeenCalled()
    // The SPECIFIC refusal, not merely one that mentions `--version`: several guards do, and matching
    // on the flag alone would keep passing if an earlier guard started firing for an unrelated reason.
    expect(error.message).toContain('no open release PRs to pick from')
    expect(error.message).toContain('--version')
    expectNothingMutated()
  })

  it('does not enter target resolution at all when --version is supplied', async () => {
    await releaseRemove({ confirmedCommand: true, version: '1.2.5' }).catch(() => {
      // The run's outcome is asserted elsewhere; this test only pins that the picker is bypassed.
    })

    expect(pickReleaseBranch).not.toHaveBeenCalled()
    expect(getReleasePRsWithInfo).not.toHaveBeenCalled()
  })
})
