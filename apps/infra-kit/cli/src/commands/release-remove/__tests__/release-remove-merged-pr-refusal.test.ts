import confirm from '@inquirer/confirm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchPRByHead } from 'src/integrations/gh/pr-status'
import { removeJiraVersion } from 'src/integrations/jira/remove-version'
import { commandEcho } from 'src/lib/command-echo'
import { deleteLocalBranch, deleteRemoteBranch } from 'src/lib/git-utils'
import { removeReleaseWorktreeIfPresent } from 'src/lib/worktrees/remove-release-worktree'

import { releaseRemove } from '../release-remove'
import { LABEL, installDefaults, releasePr } from './release-remove-mocks'
import { ranCommand } from './release-remove-zx'

/**
 * @fileoverview
 * D3: a MERGED release has shipped, and `release remove` must refuse it BEFORE it mutates anything.
 *
 * The false-success this prevents is "the guard existed but ran after step 1": a refusal that fires
 * once the worktree is already gone is not a refusal, it is a half-teardown of shipped work with an
 * error message attached. So these tests assert the NEGATIVE on every mutating collaborator —
 * `removeReleaseWorktreeIfPresent`, `deleteLocalBranch`, `deleteRemoteBranch` and `removeJiraVersion`
 * each called ZERO times — rather than merely that the call rejected.
 *
 * The second false-success is `--yes`. `confirmedCommand` skips the CONFIRM, and a guard that lived
 * in (or short-circuited with) the confirm text would silently vanish on the flag every scripted
 * invocation passes.
 *
 * The third is the re-probe in `closePrStep`. Preflight's answer is separated from step 3 by an
 * interactive confirm of unbounded duration, so a PR merged inside that window would otherwise
 * surface as an opaque `gh pr close` failure AFTER the worktree was already removed. `fetchPRByHead`
 * therefore answers OPEN once and MERGED on the re-probe, and the test asserts both that the refusal
 * carries D3's own text and that `gh pr close` never ran.
 *
 * Mocked: every collaborator that touches git, gh, Orca or Jira, plus zx's `$` — which RECORDS the
 * command line, which is what makes "no `gh pr close`" assertable at all. Real: `release-id`, the
 * pure half of `release-utils`, `buildJiraVersionUrl`, `commandEcho`, and the entire guard/step
 * control flow under test.
 */

const zx = vi.hoisted(() => {
  return { commands: [] as string[], overrides: [] as { match: string; stdout?: string; throws?: unknown }[] }
})

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()
  // Imported INSIDE the factory: this file's own top-level bindings are still in their temporal dead
  // zone while the factory runs.
  const { createZx } = await import('./release-remove-zx')

  return { ...actual, $: createZx(zx) }
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
    getProjectRoot: vi.fn(),
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

// LEAF, not the `src/lib/worktrees` barrel — `release-remove.ts:49` imports it from here, and a
// barrel mock would leave the real `git worktree remove` running.
vi.mock('src/lib/worktrees/remove-release-worktree', () => {
  return { removeReleaseWorktreeIfPresent: vi.fn() }
})

vi.mock('src/integrations/orca', () => {
  return { listOrcaTerminals: vi.fn(), orcaCallerInsideTargets: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

// LEAF, for the same reason (`release-remove.ts:11`): mocking only the barrel let the REAL
// `fetchPRByHead` run `gh pr list` during an earlier draft of this suite.
vi.mock('src/integrations/gh/pr-status', () => {
  return { fetchPRByHead: vi.fn() }
})

vi.mock('src/integrations/ide', () => {
  return { removeIdeWorktreeFolders: vi.fn() }
})

// Spread, so `buildJiraVersionUrl` stays real and the URL in the result is derived exactly as in
// production; only the two lookup calls are replaced.
vi.mock('src/integrations/jira', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/jira')>()

  return { ...actual, findVersionByName: vi.fn(), loadJiraConfigOptional: vi.fn() }
})

// LEAF (`release-remove.ts:17`): these two are the Jira calls that reach the network.
vi.mock('src/integrations/jira/remove-version', () => {
  return { getVersionRelatedIssueCounts: vi.fn(), removeJiraVersion: vi.fn() }
})

// `resolveReleaseBranch`, `getBaseBranch` and `detectReleaseType` stay REAL so the version→branch
// and PR-title→base-branch derivations are exercised as in production.
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

const expectNoMutation = (): void => {
  expect(removeReleaseWorktreeIfPresent).not.toHaveBeenCalled()
  expect(deleteLocalBranch).not.toHaveBeenCalled()
  expect(deleteRemoteBranch).not.toHaveBeenCalled()
  expect(removeJiraVersion).not.toHaveBeenCalled()
  expect(ranCommand(zx, 'gh pr close')).toBe(false)
}

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  zx.commands = []
  zx.overrides = []

  installDefaults()
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('release remove — MERGED PR refusal at preflight', () => {
  it('refuses a MERGED release before removing the worktree, the branches or the fix version', async () => {
    vi.mocked(fetchPRByHead).mockResolvedValue(releasePr({ state: 'MERGED' }))

    await expect(releaseRemove({ confirmedCommand: false, version: LABEL })).rejects.toThrow(/is MERGED/)

    expectNoMutation()
    // The guard precedes the confirm, so the operator is never even asked about shipped work.
    expect(confirm).not.toHaveBeenCalled()
  })

  it('names the shipped release and the revert path rather than a bare failure', async () => {
    vi.mocked(fetchPRByHead).mockResolvedValue(releasePr({ state: 'MERGED' }))

    const error = await releaseRemove({ confirmedCommand: false, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('this release has shipped')
    expect((error as Error).message).toContain('revert the merge commit on dev')
  })

  it('is NOT bypassed by --yes', async () => {
    vi.mocked(fetchPRByHead).mockResolvedValue(releasePr({ state: 'MERGED' }))

    await expect(releaseRemove({ confirmedCommand: true, version: LABEL })).rejects.toThrow(/is MERGED/)

    expectNoMutation()
  })
})

describe('release remove — MERGED between preflight and step 3', () => {
  it('is refused by the re-probe with D3 text, not by an opaque `gh pr close` failure', async () => {
    // Preflight sees OPEN; the re-probe inside `closePrStep` sees the merge that landed during the
    // confirm. `mockResolvedValueOnce` is what makes the two answers distinguishable.
    vi.mocked(fetchPRByHead)
      .mockResolvedValueOnce(releasePr({ state: 'OPEN' }))
      .mockResolvedValue(releasePr({ state: 'MERGED' }))

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    expect((error as Error).message).toContain('is MERGED')
    expect((error as Error).message).toContain('this release has shipped')
    // `gh pr close` is never reached: the refusal is the guard's, not the shell's.
    expect(ranCommand(zx, 'gh pr close')).toBe(false)
    expect(fetchPRByHead).toHaveBeenCalledTimes(2)

    // Everything after step 3 is unreached, so both branches and the fix version survive.
    expect(deleteLocalBranch).not.toHaveBeenCalled()
    expect(deleteRemoteBranch).not.toHaveBeenCalled()
    expect(removeJiraVersion).not.toHaveBeenCalled()
  })

  it('reports the residue truthfully: the completed steps, and the fix version NOT removed', async () => {
    vi.mocked(fetchPRByHead)
      .mockResolvedValueOnce(releasePr({ state: 'OPEN' }))
      .mockResolvedValue(releasePr({ state: 'MERGED' }))

    const error = await releaseRemove({ confirmedCommand: true, version: LABEL }).catch((e: unknown) => {
      return e
    })

    const { message } = error as Error

    expect(message).toContain('step 3 of 6 (close the PR)')
    expect(message).toContain('completed: worktree, ide-folders')
    expect(message).toContain('The Jira fix version v1.2.5 was NOT removed')
    expect(message).toContain('Re-run `infra-kit release remove')
  })
})
