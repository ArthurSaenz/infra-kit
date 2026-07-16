import confirm from '@inquirer/confirm'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'

import { commandEcho } from '../command-echo'
import { confirmOrExit } from '../confirm-or-exit'

/**
 * Behavior guard for `confirmOrExit` — the invariant core extracted from the 7
 * mutating command handlers. Pins the three observable outcomes so the
 * extraction stays byte-identical to the inlined idiom:
 *   - `confirmedCommand` truthy (CLI `--yes` / MCP) → no prompt, no exit
 *   - interactive + accepted → prompt shown, echo marked interactive, no exit
 *   - interactive + declined → cancel log + `process.exit(0)`
 */

vi.mock('@inquirer/confirm', () => {
  return { default: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const confirmMock = vi.mocked(confirm)

let setInteractiveSpy: ReturnType<typeof vi.spyOn>
let exitSpy: ReturnType<typeof vi.spyOn>

function noopExit(): never {
  return undefined as never
}

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  setInteractiveSpy = vi.spyOn(commandEcho, 'setInteractive')
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(noopExit)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('confirmOrExit', () => {
  it('skips the prompt entirely when confirmedCommand is true', async () => {
    await confirmOrExit(true, 'Proceed?')

    expect(confirmMock).not.toHaveBeenCalled()
    expect(setInteractiveSpy).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('prompts with the exact message and marks interactive when accepted', async () => {
    confirmMock.mockResolvedValue(true)

    await confirmOrExit(false, 'Are you sure you want to proceed?')

    expect(confirmMock).toHaveBeenCalledTimes(1)
    // The second argument is the prompt context `withEscape` threads in. Asserting the
    // AbortSignal is present is what proves Esc is actually WIRED here: without it the
    // prompt would still work, still be tested, and silently ignore Esc — which is the
    // half-wired state the all-or-none contract exists to prevent.
    expect(confirmMock).toHaveBeenCalledWith(
      { message: 'Are you sure you want to proceed?' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(setInteractiveSpy).toHaveBeenCalledTimes(1)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('logs cancellation and exits(0) when the user declines', async () => {
    confirmMock.mockResolvedValue(false)

    await confirmOrExit(false, 'Proceed?')

    expect(setInteractiveSpy).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith('Operation cancelled. Exiting...')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('treats undefined confirmedCommand as interactive', async () => {
    confirmMock.mockResolvedValue(true)

    await confirmOrExit(undefined, 'Proceed?')

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(setInteractiveSpy).toHaveBeenCalledTimes(1)
  })
})
