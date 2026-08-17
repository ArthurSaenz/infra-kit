import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ghMergeDev } from 'src/commands/gh-merge-dev'
import { buildProgram } from 'src/lib/program'

/**
 * The exit-code contract for `infra-kit release merge-dev`.
 *
 * A partial run used to exit 0: the command caught each branch failure, printed a
 * manual-merge script, and returned normally. Any CI step or wrapper script
 * therefore could not distinguish "merged all six" from "merged two, gave up on
 * four" — the failure was visible only to a human reading the log.
 *
 * The assertion is deliberately made against the REAL Commander action rather
 * than a re-implementation of it, because the defect was in the wiring, not in
 * the logic. `buildProgram` installs no `preAction` hooks (those live in
 * `entry/cli.ts`), so `parseAsync` here runs the action and nothing else.
 */

// PARTIAL mock: `command-catalog` imports `ghMergeDevMcpTool` from this same
// barrel, so a whole-module replacement takes the catalog down with it.
vi.mock('src/commands/gh-merge-dev', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/commands/gh-merge-dev')>()

  return { ...actual, ghMergeDev: vi.fn() }
})

// Keep the real `addJsonOption` (buildProgram calls it) and silence only `emit`.
vi.mock('src/lib/json-output', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/json-output')>()

  return { ...actual, emit: vi.fn() }
})

const runMergeDev = async (argv: string[]): Promise<void> => {
  await buildProgram().parseAsync(['release', 'merge-dev', ...argv], { from: 'user' })
}

const resultWith = (failedBranches: string[], total: number) => {
  return {
    content: [{ type: 'text' as const, text: '' }],
    structuredContent: {
      successfulMerges: total - failedBranches.length,
      failedMerges: failedBranches.length,
      failedBranches,
      totalBranches: total,
      dryRun: false,
      atomicPush: { attempted: true, aborted: failedBranches.length > 0 },
      results: [],
    },
  }
}

const originalExitCode = process.exitCode

beforeEach(() => {
  vi.clearAllMocks()
  process.exitCode = undefined
})

afterEach(() => {
  process.exitCode = originalExitCode
})

describe('uS-004 — merge-dev exit-code contract', () => {
  it('exits non-zero when any branch failed to merge', async () => {
    vi.mocked(ghMergeDev).mockResolvedValue(resultWith(['release/v1.2.6'], 2))

    await runMergeDev(['--all', '--yes'])

    expect(process.exitCode).toBe(1)
  })

  it('leaves the exit code untouched when every branch succeeded', async () => {
    vi.mocked(ghMergeDev).mockResolvedValue(resultWith([], 2))

    await runMergeDev(['--all', '--yes'])

    expect(process.exitCode).toBeUndefined()
  })

  it('passes --versions through to the command', async () => {
    vi.mocked(ghMergeDev).mockResolvedValue(resultWith([], 1))

    await runMergeDev(['--versions', '1.2.5', '--yes'])

    expect(ghMergeDev).toHaveBeenCalledWith({
      all: undefined,
      versions: '1.2.5',
      confirmedCommand: true,
    })
  })
})
