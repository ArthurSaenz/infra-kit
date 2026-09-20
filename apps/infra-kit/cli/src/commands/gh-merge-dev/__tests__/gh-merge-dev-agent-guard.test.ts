import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { agentMode } from 'src/lib/agent-mode'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertRepoWithOrigin } from 'src/lib/git-guard'
import { pickReleaseBranches } from 'src/lib/prompts/release-picker'

import { ghMergeDev } from '../gh-merge-dev'

/**
 * @fileoverview
 *
 * Regression guard for the load-bearing `!process.stdin.isTTY` clause in
 * `src/lib/prompts/release-picker.ts`. `gh-merge-dev`'s sole input (`all`) is
 * optional, so a Bash call under `--agent` that omits it genuinely enters the
 * interactive `else` branch — the ONLY thing stopping a picker (and a React load)
 * on a non-TTY stdin is that clause. This test proves the wiring in front of that
 * clause is real: an omitted-arg call reaches `pickReleaseBranches`.
 *
 * FALSIFIABILITY: `ghMergeDev({})` runs `assertManagementContext` and an
 * empty-list early-return BEFORE the `else`, either of which would make a naive
 * `rejects.toThrow(OperationError)` pass without ever reaching the shim. We
 * neutralise this by (1) mocking both upstream gates so execution genuinely
 * reaches the `else`, and (2) asserting the POSITIVE discriminator
 * `pickReleaseBranches` WAS CALLED — an assertion that dies at
 * `assertManagementContext` or the early-return cannot satisfy.
 */

// Boot: hoisted spies so we can assert the TUI is NEVER imported/called (React
// must not load under --agent) WITHOUT a static `import 'src/tui/boot'`, which
// the no-react boundary lint rule forbids in command code.
const boot = vi.hoisted(() => {
  return { runCommandPalette: vi.fn(), runBranchPicker: vi.fn(), runBranchMultiPicker: vi.fn() }
})

vi.mock('src/tui/boot', () => {
  return boot
})

// Upstream gate (a): resolve so it does not throw and short-circuit the test.
// The command swapped `assertManagementContext` for the narrower
// `assertRepoWithOrigin` when it stopped touching the operator's checkout; a mock
// exporting only the old name would leave the command calling `undefined`.
vi.mock('src/lib/git-guard', () => {
  return { assertRepoWithOrigin: vi.fn(), assertManagementContext: vi.fn() }
})

// The picker now runs AFTER the plan, so reaching it means getting through the
// scratch worktree and the merge planner first. Both are covered against real git
// elsewhere; here they only need to not touch the disk.
vi.mock('src/lib/git-utils', () => {
  return {
    getMainRepoRoot: vi.fn().mockResolvedValue('/repo'),
    withScratchWorktree: vi.fn(async (_args: unknown, fn: (wt: { path: string }) => Promise<unknown>) => {
      return fn({ path: '/scratch' })
    }),
    pushAtomic: vi.fn(),
  }
})

vi.mock('../merge-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../merge-run')>()

  return {
    ...actual,
    planMergeRun: vi.fn(async ({ branches }: { branches: string[] }) => {
      return branches.map((branch) => {
        return { branch, status: 'merged' as const, mergeSha: 'sha' }
      })
    }),
    reclassify: vi.fn(),
  }
})

vi.mock('zx', () => {
  const settled = { stdout: '', stderr: '', exitCode: 0 }
  const tag = (): Promise<typeof settled> => {
    return Promise.resolve(settled)
  }

  return {
    $: Object.assign(
      (first: unknown): unknown => {
        return Array.isArray(first) ? tag() : tag
      },
      { quiet: false },
    ),
  }
})

// Upstream gate (b): supply ≥1 regular-release PR so the empty-list early return
// is skipped. Set per-test in beforeEach.
vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

// The shim: the positive discriminator.
vi.mock('src/lib/prompts/release-picker', () => {
  return { pickReleaseBranch: vi.fn(), pickReleaseBranches: vi.fn() }
})

// `formatBranchPickerItems`/`releaseBranchLabels` stay REAL
// (via importActual); only the Jira lookup is stubbed.
vi.mock('src/lib/release-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/release-utils')>()

  return { ...actual, getJiraDescriptions: vi.fn().mockResolvedValue(new Map<string, string>()) }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const originalIsTTY = process.stdin.isTTY

beforeEach(() => {
  vi.clearAllMocks()
  // Simulate an agent's non-interactive stdin. The REAL shim would bail on
  // this; our mock stands in for that bail while proving the `else` reached it.
  process.stdin.isTTY = false
  vi.mocked(assertRepoWithOrigin).mockResolvedValue(undefined)
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([
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
  ])
  // Stand in for the real shim's non-TTY bail: throw the same OperationError,
  // halting execution before any git side effect.
  vi.mocked(pickReleaseBranches).mockRejectedValue(
    new OperationError(undefined, {
      operation: 'interactive branch selection',
      remediation: 'pass the branch selection explicitly',
    }),
  )
})

afterEach(() => {
  process.stdin.isTTY = originalIsTTY
  agentMode.source = null
})

describe('gh-merge-dev omitted-arg guard under --agent', () => {
  it('reaches the interactive shim (pickReleaseBranches) with the branch arg omitted and never loads the TUI', async () => {
    // `confirmedCommand: true` mirrors a `--yes` re-run, the shape an agent's second
    // call takes; the branch arg `all` is OMITTED, so execution must enter the `else`.
    // `rejects.toThrow(OperationError)` alone is NOT sufficient — it passes on the
    // upstream gates too. The `toHaveBeenCalled` assertions below are the real proof.
    await expect(ghMergeDev({ confirmedCommand: true })).rejects.toBeInstanceOf(OperationError)

    // Positive discriminator: the `else` branch genuinely reached the shim, with the
    // formatted picker items derived from the (real) regular-release PR.
    expect(pickReleaseBranches).toHaveBeenCalledTimes(1)
    expect(pickReleaseBranches).toHaveBeenCalledWith(
      [{ value: 'release/v1.2.5', label: '1.2.5', description: 'clean merge', type: undefined }],
      { required: true },
    )

    // The upstream gates were passed (not short-circuited), so the throw came from
    // the shim, not from the preflight.
    expect(assertRepoWithOrigin).toHaveBeenCalledTimes(1)

    // The TUI / React entry point was never imported or invoked on the non-TTY path.
    expect(boot.runBranchMultiPicker).not.toHaveBeenCalled()
    expect(boot.runBranchPicker).not.toHaveBeenCalled()
    expect(boot.runCommandPalette).not.toHaveBeenCalled()
  })
})

describe('gh-merge-dev — the confirm site propagates its refusal', () => {
  // The confirm sits inside the scratch-worktree callback and under the site's own
  // `isCommandDeclined` catch, which rethrows everything else; the refusal must come out intact,
  // before `applyPush`.
  it('an unconfirmed agent run with the branches named throws confirmation_required, pushing nothing', async () => {
    agentMode.source = 'env'

    const error = await ghMergeDev({ confirmedCommand: false, versions: '1.2.5' }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'confirmation_required',
      agentMode: 'env',
    })
    expect((error as StructuredRefusalError).exitCode).toBe(2)
    expect(pickReleaseBranches).not.toHaveBeenCalled()
  })
})
