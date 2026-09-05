import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { acquireStdin, releaseStdin } from 'src/lib/prompts/stdin-ref'

import type { PaletteItem } from '../types'

/**
 * @fileoverview
 *
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

/** Spy on the ref/unref/pause trio without letting any of them touch the real stdin handle. */
const spyOnStdin = () => {
  return {
    ref: vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin),
    unref: vi.spyOn(process.stdin, 'unref').mockReturnValue(process.stdin),
    pause: vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin),
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

/**
 * `unref()` answers "may node exit?", NOT "is anyone still reading this fd?" — so the parent keeps
 * eating tty bytes a `stdio: 'inherit'` child should have received.
 *
 * WHAT THESE TESTS ARE, HONESTLY — `pause` is spied and MOCKED, so they assert only that the branch
 * CALLS it. **They would all stay green if `process.stdin.pause()` were replaced with a no-op**, so
 * do not read them as evidence that the fix works. What they DO cover is that pausing is
 * CONDITIONAL on the reader counter, which is the part no other file can reach.
 */
// Mechanism: Ink's teardown drops its `readable` listener and unrefs (App.js:136-137) but never
// pauses, so libuv keeps reading the tty into the stream's buffer. The session shell then spawns
// the picked command with `stdio: 'inherit'` — parent and child on the SAME tty — and the kernel
// gives each keystroke to exactly one of them. Measured on a pty before the fix: a lone Esc at a
// child's prompt cancelled 1 run in 5 under the session shell versus 5 in 5 without it, and a
// wedged run swallowed every following Ctrl-C, because the parent ate the byte.
//
// Two other files carry the evidence this one cannot:
//   - `stdin-pause-semantics.test.ts` — the node contract that makes `pause()` reach libuv at all
//     (cross-platform, runs on CI);
//   - `stdin-pause-pty.test.ts` — the consequence, that a spawned child owns the tty, plus the
//     call-site invariant (darwin-only; verified 5/5 with the fix, 0/5 without).
//
// Mocking is correct here: pausing while an outer inquirer prompt is live would starve it, so a
// real pause is precisely what must not happen in the third case. The pty test in `entry/__tests__`
// is unrelated — it proves a quit key AT THE PALETTE kills the process, and here the palette is
// already gone.
describe('renderToStderr stops reading stdin so a spawned child can own the tty', () => {
  it('pauses stdin after the palette exits, so the next child is the only reader', async () => {
    const { pause } = spyOnStdin()

    waitUntilExit.mockResolvedValue(undefined)

    const pending = runCommandPalette(items)

    ;(rendered?.props as { onSelect: (name: string) => void }).onSelect('worktrees-remove')

    expect(await pending).toBe('worktrees-remove')
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('pauses on the teardown-rejects path too', async () => {
    const { pause } = spyOnStdin()

    waitUntilExit.mockRejectedValue(new Error('forced close'))

    expect(await runCommandPalette(items)).toBeNull()
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('does NOT pause while an outer inquirer prompt is still reading', async () => {
    acquireStdin()

    const { pause, ref } = spyOnStdin()

    waitUntilExit.mockResolvedValue(undefined)

    const pending = runCommandPalette(items)

    ;(rendered?.props as { onSelect: (name: string) => void }).onSelect('worktrees-remove')

    expect(await pending).toBe('worktrees-remove')
    // Pausing here would starve the prompt the counter says is live — the ref is re-asserted instead.
    expect(pause).not.toHaveBeenCalled()
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
