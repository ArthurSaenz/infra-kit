import { beforeEach, describe, expect, it, vi } from 'vitest'

import { reuseZedWorkspace } from '../reuse-zed-workspace'

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

const log = vi.hoisted(() => {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: log }
})

describe('reuseZedWorkspace', () => {
  beforeEach(() => {
    zx.calls = []
    zx.shouldThrow = false
    vi.clearAllMocks()
  })

  it('runs `zed --reuse` with the project root plus the remaining worktree paths', async () => {
    const outcome = await reuseZedWorkspace({
      projectRoot: '/repo',
      worktreeDir: '/repo.worktrees',
      remainingBranches: ['release/v1.0.0', 'release/v1.1.0'],
    })

    expect(zx.calls).toHaveLength(1)
    expect(zx.calls[0]?.[0]).toEqual(['/repo', '/repo.worktrees/release/v1.0.0', '/repo.worktrees/release/v1.1.0'])
    expect(outcome).toEqual({ ran: true })
  })

  it('collapses to root-only when no worktrees remain', async () => {
    const outcome = await reuseZedWorkspace({
      projectRoot: '/repo',
      worktreeDir: '/repo.worktrees',
      remainingBranches: [],
    })

    expect(zx.calls).toHaveLength(1)
    expect(zx.calls[0]?.[0]).toEqual(['/repo'])
    expect(outcome).toEqual({ ran: true })
  })

  it('emits a disclosure log line warning that other open folders are not preserved', async () => {
    await reuseZedWorkspace({
      projectRoot: '/repo',
      worktreeDir: '/repo.worktrees',
      remainingBranches: ['release/v1.0.0'],
    })

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('other folders in the focused window are not preserved'),
    )
  })

  it('swallows a launch failure into a best-effort warning', async () => {
    zx.shouldThrow = true

    const outcome = await reuseZedWorkspace({
      projectRoot: '/repo',
      worktreeDir: '/repo.worktrees',
      remainingBranches: ['release/v1.0.0'],
    })

    expect(outcome).toEqual({ ran: false })
    expect(log.warn).toHaveBeenCalled()
  })
})
