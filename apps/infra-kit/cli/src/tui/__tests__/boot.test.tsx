import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { acquireStdin, releaseStdin } from 'src/lib/prompts/stdin-ref'

import type { PaletteItem } from '../types'

/**
 * `renderToStderr` used to re-ref `process.stdin` UNCONDITIONALLY after every Ink render,
 * and this file used to assert exactly that — seven tests, all named "re-refs
 * process.stdin". They were green, and they were pinning a hang: a ref'd tty ReadStream
 * holds the event loop open whether or not anything listens to it, so the session shell
 * tore its palette down on Ctrl-C and then never exited.
 *
 * The contract now: Ink balances its own ref (it refs on mount, unrefs on teardown), and
 * `withEscape` owns the ref for inquirer prompts, so the DEFAULT is to touch nothing. The
 * re-assert fires only when the counter says a reader is already live — an Ink screen
 * rendered inside a `withEscape` callback, whose teardown would otherwise unref the handle
 * the outer prompt is still reading from. See lib/prompts/stdin-ref.
 *
 * `ink` is mocked here, so Ink's own ref/unref never runs; every `ref` call these tests
 * observe is one `renderToStderr` made on purpose.
 */

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

/** Spy on the ref/unref pair without letting either touch the real stdin handle. */
const spyOnStdin = () => {
  return {
    ref: vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin),
    unref: vi.spyOn(process.stdin, 'unref').mockReturnValue(process.stdin),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  waitUntilExit.mockReset()
  rendered = undefined
})

describe('renderToStderr stdin ownership — no reader live', () => {
  it('does NOT ref stdin after the palette exits, so the session shell can terminate', async () => {
    const { ref } = spyOnStdin()

    waitUntilExit.mockResolvedValue(undefined)

    const pending = runCommandPalette(items)

    // render runs synchronously; mimic Ink firing onSelect before it exits.
    ;(rendered?.props as { onSelect: (name: string) => void }).onSelect('worktrees-remove')

    expect(await pending).toBe('worktrees-remove')
    expect(ref).not.toHaveBeenCalled()
  })

  it('does NOT ref stdin when the palette teardown rejects (cancel path)', async () => {
    const { ref } = spyOnStdin()

    waitUntilExit.mockRejectedValue(new Error('forced close'))

    expect(await runCommandPalette(items)).toBeNull()
    expect(ref).not.toHaveBeenCalled()
  })

  it('does NOT ref stdin across the back-to-back palette → picker hop', async () => {
    // The old comment claimed a second Ink render would read an unref'd handle. It would
    // not: Ink refs itself on mount (ink/build/components/App.js:225).
    const { ref } = spyOnStdin()

    waitUntilExit.mockResolvedValue(undefined)

    const palettePending = runCommandPalette(items)

    ;(rendered?.props as { onSelect: (name: string) => void }).onSelect('worktrees-remove')
    expect(await palettePending).toBe('worktrees-remove')

    const pickerPending = runBranchMultiPicker(branchItems)

    ;(rendered?.props as { onSubmit: (values: string[]) => void }).onSubmit(['release/1.2.3'])
    expect(await pickerPending).toStrictEqual(['release/1.2.3'])
    expect(ref).not.toHaveBeenCalled()
  })
})

describe('renderToStderr stdin ownership — a reader is live', () => {
  it("re-asserts the ref, because Ink's teardown unref would kill the outer prompt", async () => {
    acquireStdin()

    // Spy AFTER acquiring: acquireStdin's own 0 -> 1 ref is not the call under test.
    const { ref } = spyOnStdin()

    waitUntilExit.mockResolvedValue(undefined)

    const pending = runCommandPalette(items)

    ;(rendered?.props as { onSelect: (name: string) => void }).onSelect('worktrees-remove')

    expect(await pending).toBe('worktrees-remove')
    expect(ref).toHaveBeenCalledTimes(1)

    releaseStdin()
  })

  it('re-asserts the ref on the teardown-rejects path too', async () => {
    acquireStdin()

    const { ref } = spyOnStdin()

    waitUntilExit.mockRejectedValue(new Error('forced close'))

    expect(await runCommandPalette(items)).toBeNull()
    expect(ref).toHaveBeenCalledTimes(1)

    releaseStdin()
  })
})

describe('picker return values survive the ownership change', () => {
  it('runBranchPicker returns the selected value', async () => {
    waitUntilExit.mockResolvedValue(undefined)

    const pending = runBranchPicker(branchItems)

    ;(rendered?.props as { onSelect: (value: string) => void }).onSelect('release/1.2.3')

    expect(await pending).toBe('release/1.2.3')
  })

  it('runBranchPicker resolves null when the teardown rejects', async () => {
    waitUntilExit.mockRejectedValue(new Error('forced close'))

    expect(await runBranchPicker(branchItems)).toBeNull()
  })

  it('runBranchMultiPicker returns the submitted values', async () => {
    waitUntilExit.mockResolvedValue(undefined)

    const pending = runBranchMultiPicker(branchItems)

    ;(rendered?.props as { onSubmit: (values: string[]) => void }).onSubmit(['release/1.2.3'])

    expect(await pending).toStrictEqual(['release/1.2.3'])
  })

  it('runBranchMultiPicker resolves null when the teardown rejects', async () => {
    waitUntilExit.mockRejectedValue(new Error('forced close'))

    expect(await runBranchMultiPicker(branchItems)).toBeNull()
  })
})
