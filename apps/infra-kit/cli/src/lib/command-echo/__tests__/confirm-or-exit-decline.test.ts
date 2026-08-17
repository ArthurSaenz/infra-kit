import confirm from '@inquirer/confirm'
import process from 'node:process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CommandDeclinedError } from 'src/lib/errors/command-declined-error'

import { confirmOrExit } from '../confirm-or-exit'

/**
 * `confirmOrExit` calls `process.exit(0)` on a decline, and `process.exit` skips
 * every `finally`. For a command that acquires a resource before it prompts — the
 * merge-dev scratch worktree is the motivating case — that makes the single most
 * ordinary non-happy path the one that leaks.
 *
 * The opt-in exists so those commands can unwind. Seven commands share this
 * helper, so the default must not move; the first test is the regression guard
 * for the other six.
 */

vi.mock('@inquirer/confirm', () => {
  return { default: vi.fn() }
})

vi.mock('src/lib/prompts/escapable-context', () => {
  return {
    withEscape: async <T>(fn: (ctx: unknown) => Promise<T>): Promise<T> => {
      return fn({})
    },
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('confirmOrExit — decline handling', () => {
  it('defaults to process.exit(0), so the six existing callers are unchanged', async () => {
    vi.mocked(confirm).mockResolvedValue(false as never)

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited')
    }) as never)

    await expect(confirmOrExit(undefined, 'proceed?')).rejects.toThrow('exited')
    expect(exit).toHaveBeenCalledWith(0)

    exit.mockRestore()
  })

  it('throws a catchable decline when the caller opts in — and does NOT exit', async () => {
    vi.mocked(confirm).mockResolvedValue(false as never)

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited')
    }) as never)

    await expect(confirmOrExit(undefined, 'proceed?', { throwOnDecline: true })).rejects.toBeInstanceOf(
      CommandDeclinedError,
    )

    // The whole point: the process must survive so the caller's `finally` runs.
    expect(exit).not.toHaveBeenCalled()

    exit.mockRestore()
  })

  it('lets a caller release a resource it acquired before prompting', async () => {
    vi.mocked(confirm).mockResolvedValue(false as never)

    let released = false

    const run = async (): Promise<void> => {
      try {
        await confirmOrExit(undefined, 'proceed?', { throwOnDecline: true })
      } finally {
        released = true
      }
    }

    await expect(run()).rejects.toBeInstanceOf(CommandDeclinedError)

    // Against the default (`process.exit`) path this stays false — that is the leak.
    expect(released).toBe(true)
  })

  it('is a no-op when the command was pre-confirmed (the MCP shape)', async () => {
    await expect(confirmOrExit(true, 'proceed?', { throwOnDecline: true })).resolves.toBeUndefined()
    expect(confirm).not.toHaveBeenCalled()
  })
})
