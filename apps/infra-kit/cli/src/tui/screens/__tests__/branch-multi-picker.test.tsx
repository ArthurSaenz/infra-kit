import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import type { BranchPickerItem } from '../../../lib/prompts/types'
import { BranchMultiPicker } from '../branch-multi-picker'

const items: BranchPickerItem[] = [
  { value: 'release/1.0.0', label: 'release-1.0.0', description: 'First cut', type: 'regular' },
  { value: 'release/1.1.0', label: 'release-1.1.0', description: 'Payments epic', type: 'regular' },
  { value: 'hotfix/1.0.1', label: 'hotfix-1.0.1', description: 'Login crash', type: 'hotfix' },
]

const settle = () => {
  return new Promise((resolve) => {
    setTimeout(resolve, 50)
  })
}

describe('branchMultiPicker', () => {
  it('space toggles the active row marker', async () => {
    const { lastFrame, stdin } = render(<BranchMultiPicker items={items} onSubmit={vi.fn()} onCancel={vi.fn()} />)

    expect(lastFrame() ?? '').toContain('[ ] release-1.0.0')

    stdin.write(' ')
    await settle()

    expect(lastFrame() ?? '').toContain('[x] release-1.0.0')

    stdin.write(' ')
    await settle()

    expect(lastFrame() ?? '').toContain('[ ] release-1.0.0')
  })

  it('enter submits the selected values', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<BranchMultiPicker items={items} onSubmit={onSubmit} onCancel={vi.fn()} />)

    stdin.write(' ') // toggle first
    await settle()
    stdin.write('\x1B[B') // move down
    await settle()
    stdin.write(' ') // toggle second
    await settle()
    stdin.write('\r')
    await settle()

    expect(onSubmit).toHaveBeenCalledWith(['release/1.0.0', 'release/1.1.0'])
  })

  it('enter with nothing selected does not submit and renders the required hint', async () => {
    const onSubmit = vi.fn()
    const { lastFrame, stdin } = render(<BranchMultiPicker items={items} onSubmit={onSubmit} onCancel={vi.fn()} />)

    stdin.write('\r')
    await settle()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(lastFrame() ?? '').toContain('select at least one')
  })

  it('selection persists across a filter change', async () => {
    const onSubmit = vi.fn()
    const { lastFrame, stdin } = render(<BranchMultiPicker items={items} onSubmit={onSubmit} onCancel={vi.fn()} />)

    stdin.write(' ') // select release/1.0.0
    await settle()

    stdin.write('hotfix') // filter hides the selected release row
    await settle()
    expect(lastFrame() ?? '').not.toContain('release-1.0.0')

    // Clear the filter one char at a time via backspace.
    for (let i = 0; i < 'hotfix'.length; i += 1) {
      stdin.write('\x7F')
      await settle()
    }

    // The mark survived the filter round-trip.
    expect(lastFrame() ?? '').toContain('[x] release-1.0.0')

    stdin.write('\r')
    await settle()

    expect(onSubmit).toHaveBeenCalledWith(['release/1.0.0'])
  })

  it('ctrl-a selects all items', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<BranchMultiPicker items={items} onSubmit={onSubmit} onCancel={vi.fn()} />)

    stdin.write('\x01') // ctrl-a
    await settle()
    stdin.write('\r')
    await settle()

    expect(onSubmit).toHaveBeenCalledWith(['release/1.0.0', 'release/1.1.0', 'hotfix/1.0.1'])
  })

  it('esc clears a non-empty filter instead of cancelling', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const { lastFrame, stdin } = render(<BranchMultiPicker items={items} onSubmit={onSubmit} onCancel={onCancel} />)

    stdin.write('hotfix')
    await settle()
    expect(lastFrame() ?? '').not.toContain('release-1.0.0')

    stdin.write('\x1B') // escape
    await settle()

    // Stage 1: the filter is gone and every branch is back, but the picker is still open.
    expect(onCancel).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(lastFrame() ?? '').toContain('release-1.0.0')
  })

  // Esc is a FILTER key here, never a selection key: clearing the query must not discard
  // what the user already ticked. Only stage 2 (Esc on an empty filter) throws the selection away.
  it('esc with a filter typed preserves the selection', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const { lastFrame, stdin } = render(<BranchMultiPicker items={items} onSubmit={onSubmit} onCancel={onCancel} />)

    stdin.write(' ') // tick release/1.0.0
    await settle()
    stdin.write('hotfix') // filter it out of view
    await settle()

    stdin.write('\x1B') // clears the filter only
    await settle()

    expect(onCancel).not.toHaveBeenCalled()
    expect(lastFrame() ?? '').toContain('[x] release-1.0.0')

    stdin.write('\r')
    await settle()

    expect(onSubmit).toHaveBeenCalledWith(['release/1.0.0'])
  })

  it('a second esc, on the now-empty filter, cancels and discards the selection', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(<BranchMultiPicker items={items} onSubmit={onSubmit} onCancel={onCancel} />)

    stdin.write(' ') // tick release/1.0.0
    await settle()
    stdin.write('hotfix')
    await settle()
    stdin.write('\x1B') // clears the filter
    await settle()
    expect(onCancel).not.toHaveBeenCalled()

    stdin.write('\x1B') // nothing left to clear -> cancels, selection discarded as before
    await settle()

    expect(onCancel).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('esc cancels without submitting', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(<BranchMultiPicker items={items} onSubmit={onSubmit} onCancel={onCancel} />)

    stdin.write('\x1B') // escape
    await settle()

    expect(onCancel).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // Blast-radius guard for boot.tsx's `exitOnCtrlC: false`. Ink used to swallow 0x03 in its own App
  // and unmount before the byte reached `useInput`, so this screen's ctrl+c branch never ran. Now that
  // the key is handed to the screens, THIS is what keeps Ctrl-C working here.
  it('ctrl-c cancels without submitting', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(<BranchMultiPicker items={items} onSubmit={onSubmit} onCancel={onCancel} />)

    stdin.write('\x03') // ctrl-c
    await settle()

    expect(onCancel).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
