import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { assertManagementContext } from 'src/lib/git-guard'

import { ghMergeDev } from '../gh-merge-dev'

/**
 * Regression guard for the conflict-cleanup path in `mergeDev`.
 *
 * `git merge origin/dev --no-edit` makes NO merge commit when it conflicts — HEAD
 * stays on the branch tip — so the old `git reset --merge HEAD~1` rewound one
 * *real* commit off the release branch (data loss). The correct cleanup is
 * `git merge --abort`, which restores the exact pre-merge state and drops nothing.
 *
 * This drives the whole `ghMergeDev` flow with `all: true` (skips the picker) and
 * a mocked zx `$` that reconstructs each command string and rejects on the merge,
 * forcing the catch branch. We then assert the catch invoked `git merge --abort`
 * and NEVER invoked `git reset --merge HEAD~1`. On the old line these assertions
 * fail (abort absent, reset present); after the fix they pass.
 */

// Mock zx's tagged-template `$`: reconstruct the command, record it, and reject on
// the conflicting merge so execution enters the catch. `$.quiet` is assignable
// because the command mutates it.
const zx = vi.hoisted(() => {
  const runCommands: string[] = []

  const reconstruct = (strings: TemplateStringsArray, values: unknown[]): string => {
    return strings.reduce((acc, part, i) => {
      return acc + part + (i < values.length ? String(values[i]) : '')
    }, '')
  }

  const dollar = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const cmd = reconstruct(strings, values)

      runCommands.push(cmd)

      if (cmd === 'git merge origin/dev --no-edit') {
        return Promise.reject(new Error('CONFLICT (content): Merge conflict in src/app.ts'))
      }

      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    },
    { quiet: false },
  )

  return { dollar, runCommands }
})

vi.mock('zx', () => {
  return { $: zx.dollar }
})

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

beforeEach(() => {
  vi.clearAllMocks()
  zx.runCommands.length = 0
  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([
    { branch: 'release/v1.2.5', title: 'Release v1.2.5', createdAt: '2024-01-01T00:00:00Z' },
  ])
})

describe('gh-merge-dev conflict cleanup', () => {
  it('aborts the merge (not reset HEAD~1) when `git merge origin/dev` conflicts', async () => {
    // `all: true` skips the interactive picker; `confirmedCommand: true` skips the
    // prompt — the same shape the MCP boundary produces.
    const result = await ghMergeDev({ all: true, confirmedCommand: true })

    // Sanity: the merge was attempted and reported as a failed branch (catch taken).
    expect(zx.runCommands).toContain('git merge origin/dev --no-edit')
    expect(result.structuredContent.failedMerges).toBe(1)
    expect(result.structuredContent.failedBranches).toEqual(['release/v1.2.5'])

    // The fix: cleanup aborts the in-progress merge and drops nothing.
    expect(zx.runCommands).toContain('git merge --abort')

    // The bug: it must NOT rewind a real commit off the release branch.
    expect(zx.runCommands).not.toContain('git reset --merge HEAD~1')
  })
})
