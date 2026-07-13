import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import type { BranchPickerItem } from '../../../lib/prompts/types'
import { BranchPicker } from '../branch-picker'

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

describe('branchPicker', () => {
  it('renders every item', () => {
    const { lastFrame } = render(<BranchPicker items={items} onSelect={vi.fn()} onCancel={vi.fn()} />)
    const frame = lastFrame() ?? ''

    expect(frame).toContain('release-1.0.0')
    expect(frame).toContain('release-1.1.0')
    expect(frame).toContain('hotfix-1.0.1')
  })

  it('filters on the label', async () => {
    const { lastFrame, stdin } = render(<BranchPicker items={items} onSelect={vi.fn()} onCancel={vi.fn()} />)

    stdin.write('hotfix')
    await settle()

    const frame = lastFrame() ?? ''

    expect(frame).toContain('hotfix-1.0.1')
    expect(frame).not.toContain('release-1.0.0')
  })

  it('filters on the description', async () => {
    const { lastFrame, stdin } = render(<BranchPicker items={items} onSelect={vi.fn()} onCancel={vi.fn()} />)

    stdin.write('payments')
    await settle()

    const frame = lastFrame() ?? ''

    expect(frame).toContain('release-1.1.0')
    expect(frame).not.toContain('release-1.0.0')
    expect(frame).not.toContain('hotfix-1.0.1')
  })

  it('shows an empty-state message when nothing matches', async () => {
    const { lastFrame, stdin } = render(<BranchPicker items={items} onSelect={vi.fn()} onCancel={vi.fn()} />)

    stdin.write('zzzznomatch')
    await settle()

    expect(lastFrame() ?? '').toContain('No matching branches')
  })

  it('enter selects the active item value (not label)', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(<BranchPicker items={items} onSelect={onSelect} onCancel={vi.fn()} />)

    stdin.write('\r')
    await settle()

    expect(onSelect).toHaveBeenCalledWith('release/1.0.0')
  })

  it('arrow-down then Enter selects the second item value', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(<BranchPicker items={items} onSelect={onSelect} onCancel={vi.fn()} />)

    stdin.write('\x1B[B') // arrow down
    await settle()
    stdin.write('\r')
    await settle()

    expect(onSelect).toHaveBeenCalledWith('release/1.1.0')
  })

  it('arrow-up from the first item wraps to the last', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(<BranchPicker items={items} onSelect={onSelect} onCancel={vi.fn()} />)

    stdin.write('\x1B[A') // arrow up from first -> wraps to last
    await settle()
    stdin.write('\r')
    await settle()

    expect(onSelect).toHaveBeenCalledWith('hotfix/1.0.1')
  })

  it('arrow-down from the last item wraps to the first', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(<BranchPicker items={items} onSelect={onSelect} onCancel={vi.fn()} />)

    stdin.write('\x1B[A') // wrap to last
    await settle()
    stdin.write('\x1B[B') // wrap back to first
    await settle()
    stdin.write('\r')
    await settle()

    expect(onSelect).toHaveBeenCalledWith('release/1.0.0')
  })

  it('esc cancels without selecting', async () => {
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(<BranchPicker items={items} onSelect={onSelect} onCancel={onCancel} />)

    stdin.write('\x1B') // escape
    await settle()

    expect(onCancel).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
