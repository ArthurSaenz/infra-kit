import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PaletteItem } from '../types'

// Ink `unref()`s process.stdin when it tears down raw mode on exit and never
// restores it. Without a re-ref, the Inquirer prompt the selected command opens
// reads from an unref'd stdin that no longer keeps the event loop alive: once the
// command's subprocesses settle, the loop drains mid-prompt and Node aborts
// entry/cli.ts's top-level await with "Detected unsettled top-level await"
// (exit 13). runCommandPalette must re-ref stdin once the palette exits.

// Control `waitUntilExit` so the test drives the palette teardown deterministically,
// and capture the rendered element so a test can fire its onSelect/onCancel props.
const waitUntilExit = vi.fn<() => Promise<void>>()
let rendered: ReactElement | undefined

vi.mock('ink', () => {
  return {
    render: (element: ReactElement) => {
      rendered = element

      return { waitUntilExit }
    },
  }
})

const { runCommandPalette } = await import('../boot')

const items: PaletteItem[] = [{ name: 'worktrees-remove', description: 'remove', group: 'Worktrees' }]

afterEach(() => {
  vi.restoreAllMocks()
  waitUntilExit.mockReset()
  rendered = undefined
})

describe('runCommandPalette stdin lifecycle', () => {
  it('re-refs process.stdin and returns the picked command after the palette exits', async () => {
    const refSpy = vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin)

    waitUntilExit.mockResolvedValue(undefined)

    const pending = runCommandPalette(items)

    // render runs synchronously; mimic Ink firing onSelect before it exits.
    ;(rendered?.props as { onSelect: (name: string) => void }).onSelect('worktrees-remove')

    expect(await pending).toBe('worktrees-remove')
    expect(refSpy).toHaveBeenCalledTimes(1)
  })

  it('re-refs process.stdin even when the palette teardown rejects (cancel path)', async () => {
    const refSpy = vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin)

    waitUntilExit.mockRejectedValue(new Error('forced close'))

    expect(await runCommandPalette(items)).toBeNull()
    expect(refSpy).toHaveBeenCalledTimes(1)
  })
})
