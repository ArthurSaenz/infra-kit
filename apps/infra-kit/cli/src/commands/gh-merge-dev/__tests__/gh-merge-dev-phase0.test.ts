import type { Command } from 'commander'
import process from 'node:process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import type { ReleasePRInfo } from 'src/integrations/gh'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { CommandDeclinedError } from 'src/lib/errors/command-declined-error'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertRepoWithOrigin } from 'src/lib/git-guard'
import { lsRemoteHead, pushAtomic, withScratchWorktree } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { buildProgram } from 'src/lib/program'

import { ghMergeDev } from '../gh-merge-dev'
import { planMergeRun, reclassify, verifyMerges } from '../merge-run'
import type { MergePlanEntry } from '../merge-run'

/**
 * Orchestration-level tests for `ghMergeDev`.
 *
 * The git *semantics* are covered by real-repository tests in `merge-run.test.ts`
 * and `src/lib/git-utils/__tests__/`. What is left here is policy: selector
 * resolution, the plan → select → confirm → push ordering, the decline path, and
 * the shape of the reported result. Those are worth mocking for, because the
 * question is what this function DOES with its collaborators, not what git does.
 *
 * (This file replaces the Phase 0 tests for `$.quiet` restoration and
 * `git merge --abort` guarding. Both were properties of the `git switch` engine,
 * which no longer exists — the command never checks out a branch in the
 * operator's repo and never leaves a merge in progress to abort. The cascade
 * behaviour that mattered is now covered against real git in `merge-run.test.ts`.)
 */

vi.mock('src/lib/git-guard', () => {
  return { assertRepoWithOrigin: vi.fn(), assertManagementContext: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return {
    getMainRepoRoot: vi.fn().mockResolvedValue('/repo'),
    withScratchWorktree: vi.fn(),
    pushAtomic: vi.fn(),
    lsRemoteHead: vi.fn(),
    listWorktrees: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('../merge-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../merge-run')>()

  return { ...actual, planMergeRun: vi.fn(), reclassify: vi.fn(), verifyMerges: vi.fn() }
})

vi.mock('src/lib/command-echo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/command-echo')>()

  return { ...actual, confirmOrExit: vi.fn() }
})

// zx's `$` has two call shapes and this command uses the options one:
// `$({ cwd })` returns a tagged-template function, it does not run anything.
// A mock that always resolves a promise breaks at the tag call site.
vi.mock('zx', () => {
  const settled = { stdout: '', stderr: '', exitCode: 0 }

  const tag = (): Promise<typeof settled> => {
    return Promise.resolve(settled)
  }

  const dollar = Object.assign(
    (first: unknown): unknown => {
      return Array.isArray(first) ? tag() : tag
    },
    { quiet: false },
  )

  return { $: dollar }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const PRS: ReleasePRInfo[] = [
  {
    branch: 'release/v1.2.5',
    number: 1,
    title: 'Release v1.2.5',
    createdAt: '2024-01-01T00:00:00Z',
    baseRefName: 'dev',
    type: 'regular',
    titleMismatch: false,
    dualBase: false,
  },
  {
    branch: 'release/v1.2.6',
    number: 2,
    title: 'Release v1.2.6',
    createdAt: '2024-01-02T00:00:00Z',
    baseRefName: 'dev',
    type: 'regular',
    titleMismatch: false,
    dualBase: false,
  },
  {
    branch: 'release/v9.9.9',
    number: 3,
    title: 'Hotfix v9.9.9',
    createdAt: '2024-01-03T00:00:00Z',
    baseRefName: 'main',
    type: 'hotfix',
    titleMismatch: false,
    dualBase: false,
  },
]

// The three ways a discovered PR is NOT a merge-dev candidate, beyond a plain hotfix:
// a hotfix retitled in the GitHub UI (the title detector no longer sees it, the base still
// does), a dev-based PR wearing a hotfix title, and a head with open PRs to both bases.
const RETITLED_HOTFIX: ReleasePRInfo = {
  branch: 'release/v9.9.8',
  number: 4,
  title: '🔥 Hotfix v9.9.8',
  createdAt: '2024-01-04T00:00:00Z',
  baseRefName: 'main',
  type: 'hotfix',
  titleMismatch: true,
  dualBase: false,
}

const MISLABELLED_REGULAR: ReleasePRInfo = {
  branch: 'release/v1.2.7',
  number: 5,
  title: 'Hotfix v1.2.7',
  createdAt: '2024-01-05T00:00:00Z',
  baseRefName: 'dev',
  type: 'regular',
  titleMismatch: true,
  dualBase: false,
}

const DUAL_BASE: ReleasePRInfo = {
  branch: 'release/v1.2.8',
  number: 6,
  title: 'Release v1.2.8',
  createdAt: '2024-01-06T00:00:00Z',
  baseRefName: 'main',
  type: 'hotfix',
  titleMismatch: true,
  dualBase: true,
}

const planned = (branches: string[]): MergePlanEntry[] => {
  return branches.map((branch, index) => {
    return { branch, status: 'merged' as const, mergeSha: `sha${index}` }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  vi.mocked(assertRepoWithOrigin).mockResolvedValue(undefined)
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue(PRS)
  vi.mocked(confirmOrExit).mockResolvedValue(undefined)
  vi.mocked(pushAtomic).mockResolvedValue({ refspecs: [], pushed: true })

  // Run the callback against a stand-in worktree, and prove the lifecycle wrapper
  // is what the command actually goes through.
  vi.mocked(withScratchWorktree).mockImplementation(async (_args, fn) => {
    return fn({ path: '/scratch', remove: vi.fn() })
  })

  vi.mocked(planMergeRun).mockImplementation(async ({ branches }) => {
    return planned(branches)
  })

  vi.mocked(reclassify).mockImplementation(async (_cwd, refs) => {
    return { kept: refs, nowUpToDate: [] }
  })
})

describe('--versions resolution', () => {
  it('accepts version labels and plans only the named branches', async () => {
    await ghMergeDev({ versions: '1.2.6', confirmedCommand: true })

    expect(planMergeRun).toHaveBeenCalledWith(expect.objectContaining({ branches: ['release/v1.2.6'] }))
  })

  it('accepts raw branch names', async () => {
    await ghMergeDev({ versions: 'release/v1.2.5, release/v1.2.6', confirmedCommand: true })

    expect(planMergeRun).toHaveBeenCalledWith(
      expect.objectContaining({ branches: ['release/v1.2.5', 'release/v1.2.6'] }),
    )
  })

  it('accepts an array (the MCP shape)', async () => {
    await ghMergeDev({ versions: ['1.2.5'], confirmedCommand: true })

    expect(planMergeRun).toHaveBeenCalledWith(expect.objectContaining({ branches: ['release/v1.2.5'] }))
  })

  it('normalises to the PR listing order regardless of the order typed', async () => {
    await ghMergeDev({ versions: '1.2.6,1.2.5', confirmedCommand: true })

    expect(planMergeRun).toHaveBeenCalledWith(
      expect.objectContaining({ branches: ['release/v1.2.5', 'release/v1.2.6'] }),
    )
  })

  it('rEFUSES a hotfix branch — it targets main, not dev', async () => {
    // 9.9.9 is an open release branch, but its PR targets main, so it is absent
    // from the regular-release set. Resolving selectors against branch names
    // alone would merge dev straight into a branch that targets main.
    await expect(ghMergeDev({ versions: '9.9.9', confirmedCommand: true })).rejects.toThrow(
      'release/v9.9.9 is skipped: hotfix (targets main)',
    )

    expect(planMergeRun).not.toHaveBeenCalled()
  })

  it('refuses a retitled hotfix by its base, and names the reason', async () => {
    // The title no longer starts with "Hotfix", so a title-based guard would
    // classify it regular and merge dev into a branch that targets main.
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([...PRS, RETITLED_HOTFIX])

    const run = ghMergeDev({ versions: '9.9.8', confirmedCommand: true })

    await expect(run).rejects.toBeInstanceOf(OperationError)
    await expect(run).rejects.toThrow('release/v9.9.8 is skipped: title/base mismatch')
    expect(planMergeRun).not.toHaveBeenCalled()
  })

  it('refuses a dual-base head with the dual reason, not the hotfix one', async () => {
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([...PRS, DUAL_BASE])

    await expect(ghMergeDev({ versions: '1.2.8', confirmedCommand: true })).rejects.toThrow(
      'release/v1.2.8 is skipped: open PRs to both dev and main',
    )
  })

  it('refuses an unknown selector and names the valid set', async () => {
    const run = ghMergeDev({ versions: '4.5.6', confirmedCommand: true })

    await expect(run).rejects.toThrow(/release\/v1\.2\.5/)
    await expect(run).rejects.toThrow('release/v4.5.6 is not an open regular release branch')
  })

  it('refuses an unparseable selector', async () => {
    await expect(ghMergeDev({ versions: '???', confirmedCommand: true })).rejects.toBeInstanceOf(OperationError)
  })
})

describe('ordering and lifecycle', () => {
  it('plans inside the scratch worktree and pushes only after confirming', async () => {
    await ghMergeDev({ all: true, confirmedCommand: true })

    expect(withScratchWorktree).toHaveBeenCalledTimes(1)
    expect(planMergeRun).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: '/scratch' }))

    // Reclassification is not optional: without it, one branch a teammate merged
    // mid-run would abort the atomic push for every other branch.
    expect(reclassify).toHaveBeenCalledTimes(1)
    expect(pushAtomic).toHaveBeenCalledTimes(1)
  })

  it('pushes nothing on --dry-run, and reports no merges', async () => {
    const result = await ghMergeDev({ all: true, dryRun: true, confirmedCommand: true })

    expect(pushAtomic).not.toHaveBeenCalled()
    expect(confirmOrExit).not.toHaveBeenCalled()

    // A dry run claiming N merges would mislead every existing --json consumer.
    expect(result.structuredContent.dryRun).toBe(true)
    expect(result.structuredContent.successfulMerges).toBe(0)
    expect(
      result.structuredContent.results.every((entry) => {
        return !entry.pushed
      }),
    ).toBe(true)
  })

  it('pushes nothing when the operator declines, and does not throw', async () => {
    vi.mocked(confirmOrExit).mockRejectedValue(new CommandDeclinedError())

    const result = await ghMergeDev({ all: true, confirmedCommand: false })

    expect(pushAtomic).not.toHaveBeenCalled()
    expect(result.structuredContent.successfulMerges).toBe(0)
    expect(result.structuredContent.atomicPush.attempted).toBe(false)
  })

  it('opts into throwOnDecline, because the scratch worktree is alive at the prompt', async () => {
    await ghMergeDev({ all: true, confirmedCommand: false })

    // Without this, `confirmOrExit` calls process.exit(0), which skips the
    // `finally` that removes the worktree — leaking one on every decline.
    expect(confirmOrExit).toHaveBeenCalledWith(
      false,
      expect.any(String),
      expect.objectContaining({ throwOnDecline: true }),
    )
  })

  it('drops a branch a teammate merged mid-run rather than aborting the push', async () => {
    vi.mocked(reclassify).mockResolvedValue({
      kept: [{ branch: 'release/v1.2.5', sha: 'sha0' }],
      nowUpToDate: ['release/v1.2.6'],
    })

    await ghMergeDev({ all: true, confirmedCommand: true })

    expect(pushAtomic).toHaveBeenCalledWith('/repo', [{ branch: 'release/v1.2.5', sha: 'sha0' }])
  })

  it('reports push-aborted for every pushable branch when the atomic push is rejected', async () => {
    vi.mocked(pushAtomic).mockResolvedValue({ refspecs: [], pushed: false, stderr: '! [rejected] (fetch first)' })
    vi.mocked(lsRemoteHead).mockResolvedValue(null)

    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    expect(result.structuredContent.atomicPush.aborted).toBe(true)
    expect(
      result.structuredContent.results.map((entry) => {
        return entry.status
      }),
    ).toEqual(['push-aborted', 'push-aborted'])
    expect(result.structuredContent.failedMerges).toBe(2)
  })

  it('checks origin rather than inferring it when the push reports failure', async () => {
    // The dangerous case: the push LANDED server-side but the response was lost,
    // so origin is fully advanced while we are about to say "aborted" — and
    // --atomic makes that wrong report more credible, not less, because the
    // operator has been told all-or-nothing.
    vi.mocked(pushAtomic).mockResolvedValue({ refspecs: [], pushed: false, stderr: 'fatal: the remote end hung up' })
    vi.mocked(lsRemoteHead).mockImplementation(async (_cwd: string, branch: string) => {
      return branch === 'release/v1.2.5' ? 'sha0' : null
    })

    await ghMergeDev({ all: true, confirmedCommand: true })

    // It must have gone and looked, once per ref it tried to push.
    expect(lsRemoteHead).toHaveBeenCalledWith('/repo', 'release/v1.2.5')
    expect(lsRemoteHead).toHaveBeenCalledWith('/repo', 'release/v1.2.6')
    expect(vi.mocked(logger.warn).mock.calls.flat().join(' ')).toContain('release/v1.2.5')
  })

  it('returns the empty shape when there are no regular release branches', async () => {
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([PRS[2]!])

    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    expect(result.structuredContent.totalBranches).toBe(0)
    expect(withScratchWorktree).not.toHaveBeenCalled()
  })
})

describe('skipped — every non-candidate is reported with its reason', () => {
  const skippedOf = (result: Awaited<ReturnType<typeof ghMergeDev>>) => {
    return result.structuredContent.skipped
  }

  it('classifies a plain hotfix by its base and leaves it out of the --all plan', async () => {
    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    expect(skippedOf(result)).toEqual([{ branch: 'release/v9.9.9', reason: 'hotfix (targets main)' }])
    expect(planMergeRun).toHaveBeenCalledWith(
      expect.objectContaining({ branches: ['release/v1.2.5', 'release/v1.2.6'] }),
    )
  })

  it('keeps a retitled hotfix out of the --all plan', async () => {
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([...PRS, RETITLED_HOTFIX])

    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    expect(planMergeRun).toHaveBeenCalledWith(
      expect.objectContaining({ branches: ['release/v1.2.5', 'release/v1.2.6'] }),
    )
    expect(skippedOf(result)).toContainEqual({ branch: 'release/v9.9.8', reason: 'title/base mismatch' })
  })

  it('skips a dev-based PR whose title says hotfix, and a dual-base head, without planning either', async () => {
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([...PRS, MISLABELLED_REGULAR, DUAL_BASE])

    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    // Precedence: a dual-base row is also a mismatched hotfix, and must say "dual".
    expect(skippedOf(result)).toEqual([
      { branch: 'release/v9.9.9', reason: 'hotfix (targets main)' },
      { branch: 'release/v1.2.7', reason: 'title/base mismatch' },
      { branch: 'release/v1.2.8', reason: 'open PRs to both dev and main' },
    ])

    const plannedBranches = vi.mocked(planMergeRun).mock.calls[0]?.[0].branches

    expect(plannedBranches).not.toContain('release/v1.2.7')
    expect(plannedBranches).not.toContain('release/v1.2.8')
  })

  it('lists the skipped rows with their reasons in the plan printout', async () => {
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([...PRS, RETITLED_HOTFIX])

    await ghMergeDev({ all: true, dryRun: true, confirmedCommand: true })

    const printed = vi
      .mocked(logger.info)
      .mock.calls.flat()
      .filter((line) => {
        return typeof line === 'string'
      })

    expect(printed).toContain('  release/v9.9.9 — skipped: hotfix (targets main)')
    expect(printed).toContain('  release/v9.9.8 — skipped: title/base mismatch')
  })

  it('carries the N skipped rows on the no-candidates early return', async () => {
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([PRS[2]!, RETITLED_HOTFIX])

    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    // An agent reading `--json` must see WHY nothing was merged, not an empty run
    // indistinguishable from "no release PRs exist".
    expect(result.structuredContent.totalBranches).toBe(0)
    expect(skippedOf(result)).toEqual([
      { branch: 'release/v9.9.9', reason: 'hotfix (targets main)' },
      { branch: 'release/v9.9.8', reason: 'title/base mismatch' },
    ])
    expect(logger.info).toHaveBeenCalledWith(
      'ℹ️ No open regular release branches — 2 skipped (hotfix (targets main) ×1, title/base mismatch ×1)',
    )
  })

  it('is empty only when nothing was discovered', async () => {
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])

    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    expect(skippedOf(result)).toEqual([])
    expect(logger.info).toHaveBeenCalledWith('ℹ️ No open release branches found')
  })
})

describe('d8 — the echoed flag is one the real CLI accepts', () => {
  it('echoes --versions as branch names and Commander knows the option', async () => {
    await ghMergeDev({ versions: '1.2.5', confirmedCommand: true })

    expect(commandEcho.formatOptions()).toBe('--versions "release/v1.2.5"')

    const byName = (name: string) => {
      return (cmd: Command): boolean => {
        return cmd.name() === name
      }
    }

    const mergeDev = buildProgram().commands.find(byName('release'))?.commands.find(byName('merge-dev'))

    const flags = mergeDev?.options.map((opt) => {
      return opt.long
    })

    // Before this fix `configureMergeDev` declared only --all and --yes, so the
    // printed "equivalent command" died on Commander's unknown-option error.
    expect(flags).toContain('--versions')
  })
})

describe('the MCP path installs no process-level signal handler', () => {
  it('leaves the SIGINT/SIGTERM listener counts untouched across a call', async () => {
    // `ghMergeDev` is the MCP tool handler as well as the CLI one. The signal
    // guard belongs to `configureMergeDev`'s action, NOT here: inside the
    // long-lived server a per-invocation handler calling process.exit(130) would
    // preempt the host's shutdown and kill the server on a stray signal.
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    }

    await ghMergeDev({ all: true, confirmedCommand: true })

    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT)
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM)
  })
})

describe('--verify runs pre-push and never rolls back', () => {
  beforeEach(() => {
    vi.mocked(verifyMerges).mockImplementation(async ({ refs }) => {
      return { kept: refs, failed: new Map() }
    })
  })

  it('does not run at all unless asked', async () => {
    await ghMergeDev({ all: true, confirmedCommand: true })

    expect(verifyMerges).not.toHaveBeenCalled()
    expect(reclassify).toHaveBeenCalledTimes(1)
  })

  it('bare --verify uses the cheap install tier', async () => {
    await ghMergeDev({ all: true, verify: true, confirmedCommand: true })

    expect(verifyMerges).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'pnpm install --frozen-lockfile', worktreePath: '/scratch' }),
    )
  })

  it('a string --verify runs that command verbatim', async () => {
    await ghMergeDev({ all: true, verify: 'pnpm run ts-check', confirmedCommand: true })

    expect(verifyMerges).toHaveBeenCalledWith(expect.objectContaining({ command: 'pnpm run ts-check' }))
  })

  it('reclassifies AGAIN after verifying — the pass is the only slow step', async () => {
    await ghMergeDev({ all: true, verify: true, confirmedCommand: true })

    // Verification can take minutes. A teammate merging during it makes the first
    // reclassification stale, and under --atomic one stale ref aborts the push for
    // EVERY branch — the exact failure reclassification exists to prevent.
    expect(reclassify).toHaveBeenCalledTimes(2)
  })

  it('drops a failing branch from the push and reports verify-failed', async () => {
    vi.mocked(verifyMerges).mockResolvedValue({
      kept: [{ branch: 'release/v1.2.5', sha: 'sha0' }],
      failed: new Map([['release/v1.2.6', 'lockfile would change']]),
    })

    const result = await ghMergeDev({ all: true, verify: true, confirmedCommand: true })

    // Dropped, not rolled back: verification is pre-push precisely so that
    // rewinding a shared ref never becomes the remedy.
    expect(pushAtomic).toHaveBeenCalledWith('/repo', [{ branch: 'release/v1.2.5', sha: 'sha0' }])

    const failed = result.structuredContent.results.find((entry) => {
      return entry.branch === 'release/v1.2.6'
    })

    expect(failed?.status).toBe('verify-failed')
    expect(failed?.reason).toBe('lockfile would change')
    expect(failed?.pushed).toBe(false)
  })

  it('is skipped entirely on a dry run', async () => {
    await ghMergeDev({ all: true, verify: true, dryRun: true, confirmedCommand: true })

    expect(verifyMerges).not.toHaveBeenCalled()
    expect(pushAtomic).not.toHaveBeenCalled()
  })
})
