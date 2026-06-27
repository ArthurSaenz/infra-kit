import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import type { PaletteItem } from '../../types'
import { CommandPalette } from '../command-palette'

const items: PaletteItem[] = [
  { name: 'release-list', description: 'List all release branches', group: 'Release Management' },
  { name: 'worktrees-list', description: 'List all git worktrees', group: 'Worktrees' },
  { name: 'env-status', description: 'Show Doppler authentication status', group: 'Environment' },
]

const settle = () => {
  return new Promise((resolve) => {
    setTimeout(resolve, 50)
  })
}

describe('commandPalette', () => {
  it('renders every command under its group header', () => {
    const { lastFrame } = render(<CommandPalette items={items} onSelect={vi.fn()} onCancel={vi.fn()} />)
    const frame = lastFrame() ?? ''

    expect(frame).toContain('release-list')
    expect(frame).toContain('worktrees-list')
    expect(frame).toContain('env-status')
    expect(frame).toContain('— Release Management —')
    expect(frame).toContain('— Worktrees —')
  })

  it('filters the list as the user types', async () => {
    const { lastFrame, stdin } = render(<CommandPalette items={items} onSelect={vi.fn()} onCancel={vi.fn()} />)

    stdin.write('env')
    await settle()

    const frame = lastFrame() ?? ''

    expect(frame).toContain('env-status')
    expect(frame).not.toContain('release-list')
  })

  it('shows an empty-state message when nothing matches', async () => {
    const { lastFrame, stdin } = render(<CommandPalette items={items} onSelect={vi.fn()} onCancel={vi.fn()} />)

    stdin.write('zzzznomatch')
    await settle()

    expect(lastFrame() ?? '').toContain('No matching commands')
  })

  it('enter selects the active (first by default) command', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={onSelect} onCancel={vi.fn()} />)

    stdin.write('\r')
    await settle()

    expect(onSelect).toHaveBeenCalledWith('release-list')
  })

  it('arrow-down then Enter selects the second command', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={onSelect} onCancel={vi.fn()} />)

    stdin.write('\u001B[B') // arrow down
    await settle()
    stdin.write('\r')
    await settle()

    expect(onSelect).toHaveBeenCalledWith('worktrees-list')
  })

  it('typing then Enter selects the filtered command', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={onSelect} onCancel={vi.fn()} />)

    stdin.write('env')
    await settle()
    stdin.write('\r')
    await settle()

    expect(onSelect).toHaveBeenCalledWith('env-status')
  })

  it('esc cancels without selecting', async () => {
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={onSelect} onCancel={onCancel} />)

    stdin.write('\u001B') // escape
    await settle()

    expect(onCancel).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
