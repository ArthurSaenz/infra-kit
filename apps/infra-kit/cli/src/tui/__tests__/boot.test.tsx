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

const { runBranchMultiPicker, runBranchPicker, runCommandPalette } = await import('../boot')

const items: PaletteItem[] = [{ name: 'worktrees-remove', description: 'remove', group: 'Worktrees' }]

const branchItems = [{ value: 'release/1.2.3', label: 'release/1.2.3' }]

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

describe('runBranchPicker stdin lifecycle', () => {
  it('re-refs process.stdin and returns the selected value', async () => {
    const refSpy = vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin)

    waitUntilExit.mockResolvedValue(undefined)

    const pending = runBranchPicker(branchItems)

    ;(rendered?.props as { onSelect: (value: string) => void }).onSelect('release/1.2.3')

    expect(await pending).toBe('release/1.2.3')
    expect(refSpy).toHaveBeenCalledTimes(1)
  })

  it('re-refs process.stdin and resolves null when the teardown rejects', async () => {
    const refSpy = vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin)

    waitUntilExit.mockRejectedValue(new Error('forced close'))

    expect(await runBranchPicker(branchItems)).toBeNull()
    expect(refSpy).toHaveBeenCalledTimes(1)
  })
})

describe('runBranchMultiPicker stdin lifecycle', () => {
  it('re-refs process.stdin and returns the submitted values', async () => {
    const refSpy = vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin)

    waitUntilExit.mockResolvedValue(undefined)

    const pending = runBranchMultiPicker(branchItems)

    ;(rendered?.props as { onSubmit: (values: string[]) => void }).onSubmit(['release/1.2.3'])

    expect(await pending).toStrictEqual(['release/1.2.3'])
    expect(refSpy).toHaveBeenCalledTimes(1)
  })

  it('re-refs process.stdin and resolves null when the teardown rejects', async () => {
    const refSpy = vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin)

    waitUntilExit.mockRejectedValue(new Error('forced close'))

    expect(await runBranchMultiPicker(branchItems)).toBeNull()
    expect(refSpy).toHaveBeenCalledTimes(1)
  })
})

describe('ink → Ink lifecycle (bare-menu palette → picker in one process)', () => {
  it('re-refs process.stdin after each teardown across back-to-back renders', async () => {
    const refSpy = vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin)

    waitUntilExit.mockResolvedValue(undefined)

    const palettePending = runCommandPalette(items)

    ;(rendered?.props as { onSelect: (name: string) => void }).onSelect('worktrees-remove')
    expect(await palettePending).toBe('worktrees-remove')
    expect(refSpy).toHaveBeenCalledTimes(1)

    const pickerPending = runBranchMultiPicker(branchItems)

    ;(rendered?.props as { onSubmit: (values: string[]) => void }).onSubmit(['release/1.2.3'])
    expect(await pickerPending).toStrictEqual(['release/1.2.3'])
    expect(refSpy).toHaveBeenCalledTimes(2)
  })
})
