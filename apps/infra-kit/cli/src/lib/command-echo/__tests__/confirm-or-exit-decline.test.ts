import confirm from '@inquirer/confirm'
import process from 'node:process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CommandDeclinedError } from 'src/lib/errors/command-declined-error'

import { confirmOrExit } from '../confirm-or-exit'

/**
 * A decline throws instead of exiting: `process.exit` skips every `finally`, and a command that acquires
 * a resource before it prompts (the merge-dev scratch worktree) would leak it on the most ordinary
 * non-happy path. `exitForError` turns the throw into exit 0.
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
  it('throws a catchable decline — and does NOT exit', async () => {
    vi.mocked(confirm).mockResolvedValue(false as never)

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited')
    }) as never)

    await expect(confirmOrExit(undefined, 'proceed?')).rejects.toBeInstanceOf(CommandDeclinedError)

    // The whole point: the process must survive so the caller's `finally` runs.
    expect(exit).not.toHaveBeenCalled()

    exit.mockRestore()
  })

  it('lets a caller release a resource it acquired before prompting', async () => {
    vi.mocked(confirm).mockResolvedValue(false as never)

    let released = false

    const run = async (): Promise<void> => {
      try {
        await confirmOrExit(undefined, 'proceed?')
      } finally {
        released = true
      }
    }

    await expect(run()).rejects.toBeInstanceOf(CommandDeclinedError)

    expect(released).toBe(true)
  })

  it('is a no-op when the command was pre-confirmed (the MCP shape)', async () => {
    await expect(confirmOrExit(true, 'proceed?')).resolves.toBeUndefined()
    expect(confirm).not.toHaveBeenCalled()
  })
})
