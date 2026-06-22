import { beforeEach, describe, expect, it, vi } from 'vitest'

import { openZedWorkspace } from '../open-zed-workspace'

const zx = vi.hoisted(() => {
  return { calls: [] as unknown[][], shouldThrow: false }
})

vi.mock('zx', () => {
  return {
    $: vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
      zx.calls.push(values)

      if (zx.shouldThrow) {
        return Promise.reject(new Error('zed failed to launch'))
      }

      return Promise.resolve({ stdout: '' })
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
})

describe('openZedWorkspace', () => {
  beforeEach(() => {
    zx.calls = []
    zx.shouldThrow = false
  })

  it('opens a single workspace with the project root plus every worktree path', async () => {
    const outcome = await openZedWorkspace({
      projectRoot: '/repo',
      worktreeDir: '/repo.worktrees',
      currentBranches: ['release/v1.0.0', 'release/v1.1.0'],
      skipRelaunchWhenEmpty: false,
    })

    expect(zx.calls).toHaveLength(1)
    expect(zx.calls[0]?.[0]).toEqual(['/repo', '/repo.worktrees/release/v1.0.0', '/repo.worktrees/release/v1.1.0'])
    expect(outcome).toEqual({ ran: true, added: 2, removed: 0 })
  })

  it('still opens the bare project root when there are worktrees but relaunch is not skipped', async () => {
    const outcome = await openZedWorkspace({
      projectRoot: '/repo',
      worktreeDir: '/repo.worktrees',
      currentBranches: [],
      skipRelaunchWhenEmpty: false,
    })

    expect(zx.calls).toHaveLength(1)
    expect(zx.calls[0]?.[0]).toEqual(['/repo'])
    expect(outcome).toEqual({ ran: true, added: 0, removed: 0 })
  })

  it('skips launching when skipRelaunchWhenEmpty is set and there are no worktrees', async () => {
    const outcome = await openZedWorkspace({
      projectRoot: '/repo',
      worktreeDir: '/repo.worktrees',
      currentBranches: [],
      skipRelaunchWhenEmpty: true,
    })

    expect(zx.calls).toHaveLength(0)
    expect(outcome).toEqual({ ran: false, added: 0, removed: 0 })
  })

  it('swallows a launch failure into a best-effort warning', async () => {
    zx.shouldThrow = true

    const outcome = await openZedWorkspace({
      projectRoot: '/repo',
      worktreeDir: '/repo.worktrees',
      currentBranches: ['release/v1.0.0'],
      skipRelaunchWhenEmpty: false,
    })

    expect(outcome).toEqual({ ran: false, added: 0, removed: 0 })
  })
})
