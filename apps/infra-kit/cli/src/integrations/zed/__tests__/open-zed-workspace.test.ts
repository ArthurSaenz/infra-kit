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

  it('opens a single workspace from the given folder paths', async () => {
    const outcome = await openZedWorkspace({
      worktreePaths: ['/repo', '/repo.worktrees/release/v1.0.0', '/repo.worktrees/release/v1.1.0'],
    })

    expect(zx.calls).toHaveLength(1)
    expect(zx.calls[0]?.[0]).toEqual(['/repo', '/repo.worktrees/release/v1.0.0', '/repo.worktrees/release/v1.1.0'])
    expect(outcome).toEqual({ ran: true, added: 3, removed: 0 })
  })

  it('skips launching when the folder set is empty', async () => {
    const outcome = await openZedWorkspace({ worktreePaths: [] })

    expect(zx.calls).toHaveLength(0)
    expect(outcome).toEqual({ ran: false, added: 0, removed: 0 })
  })

  it('swallows a launch failure into a best-effort warning', async () => {
    zx.shouldThrow = true

    const outcome = await openZedWorkspace({ worktreePaths: ['/repo', '/repo.worktrees/release/v1.0.0'] })

    expect(outcome).toEqual({ ran: false, added: 0, removed: 0 })
  })
})
