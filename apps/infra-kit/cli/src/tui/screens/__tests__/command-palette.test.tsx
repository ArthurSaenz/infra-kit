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

  it('arrow-up from the first command wraps to the last', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={onSelect} onCancel={vi.fn()} />)

    stdin.write('[A') // arrow up from first
    await settle()
    stdin.write('\r')
    await settle()

    expect(onSelect).toHaveBeenCalledWith('env-status')
  })

  it('arrow-down from the last command wraps to the first', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={onSelect} onCancel={vi.fn()} />)

    stdin.write('[A') // arrow up from first -> wraps to last (env-status)
    await settle()
    stdin.write('[B') // arrow down from last -> wraps to first (release-list)
    await settle()
    stdin.write('\r')
    await settle()

    expect(onSelect).toHaveBeenCalledWith('release-list')
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

  it('clears the rendered list after a command is selected', async () => {
    const { lastFrame, stdin } = render(<CommandPalette items={items} onSelect={vi.fn()} onCancel={vi.fn()} />)

    expect(lastFrame() ?? '').toContain('release-list')

    stdin.write('\r')
    await settle()

    // Final frame renders empty so Ink erases the list instead of freezing it
    // into the scrollback above the command's own output.
    expect(lastFrame() ?? '').not.toContain('release-list')
  })

  it('esc does nothing when the filter is empty — the palette is the root', async () => {
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={onSelect} onCancel={onCancel} />)

    stdin.write('\u001B') // escape
    await settle()

    expect(onCancel).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  // The one that separates "Esc is a no-op" from "Esc killed the component": an unmounted palette also
  // never calls onCancel, so the test above cannot tell those apart on its own. Esc used to set
  // `submitted`, after which useInput early-returns and swallows every later key — including this Enter.
  it('esc on an empty filter leaves the palette live', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={onSelect} onCancel={vi.fn()} />)

    stdin.write(String.fromCharCode(27)) // escape
    await settle()
    stdin.write('\r')
    await settle()

    expect(onSelect).toHaveBeenCalledWith('release-list')
  })

  // The filter state is asserted through `onSelect`, not `lastFrame()` alone: a frame assertion would
  // otherwise be the only thing separating "Esc cleared the filter" from "Esc did nothing at all", and
  // ink-testing-library frames are not trustworthy enough to carry that distinction by themselves.
  it('esc clears a non-empty filter', async () => {
    const onCancel = vi.fn()
    const onSelect = vi.fn()
    const { lastFrame, stdin } = render(<CommandPalette items={items} onSelect={onSelect} onCancel={onCancel} />)

    stdin.write('env')
    await settle()
    expect(lastFrame() ?? '').not.toContain('release-list')

    stdin.write(String.fromCharCode(27)) // escape — clears the filter, does not quit
    await settle()
    stdin.write('\r')
    await settle()

    // The FIRST unfiltered command, not the one `env` had narrowed the list to.
    expect(onSelect).toHaveBeenCalledWith('release-list')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('ctrl-d quits with an empty filter', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={vi.fn()} onCancel={onCancel} />)

    stdin.write(String.fromCharCode(4)) // ctrl-d
    await settle()

    expect(onCancel).toHaveBeenCalled()
  })

  it('ctrl-d quits even with a non-empty filter — it is not part of the esc ladder', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={vi.fn()} onCancel={onCancel} />)

    stdin.write('env')
    await settle()
    stdin.write(String.fromCharCode(4)) // ctrl-d — unconditional, unlike esc
    await settle()

    expect(onCancel).toHaveBeenCalled()
  })

  it('ctrl-c cancels even with a non-empty filter', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(<CommandPalette items={items} onSelect={vi.fn()} onCancel={onCancel} />)

    stdin.write('env')
    await settle()
    stdin.write(String.fromCharCode(3)) // ctrl-c
    await settle()

    expect(onCancel).toHaveBeenCalled()
  })

  /**
   * WIRING ONLY. These prove the keystroke reaches the callback and that the hint tracks the prop —
   * nothing more. They say NOTHING about whether the terminal is actually handed back correctly:
   * ink-testing-library renders into a fake stdout, so raw mode, the cursor and the frame-erase are
   * all fiction here. Terminal state is verified in scripts/qa/suspend-pty.sh, on a real pty.
   */
  describe('ctrl-z (wiring only — terminal state is proven in scripts/qa/suspend-pty.sh)', () => {
    it('calls onSuspend once', async () => {
      const onSuspend = vi.fn()
      const { stdin } = render(
        <CommandPalette items={items} onSelect={vi.fn()} onCancel={vi.fn()} onSuspend={onSuspend} />,
      )

      stdin.write('\x1A') // ctrl-z — a BYTE, not a signal: Ink's raw mode clears termios ISIG
      await settle()

      expect(onSuspend).toHaveBeenCalledTimes(1)
    })

    it('does not cancel or select — the palette stays mounted so the filter survives the suspend', async () => {
      const onCancel = vi.fn()
      const onSelect = vi.fn()
      const { lastFrame, stdin } = render(
        <CommandPalette items={items} onSelect={onSelect} onCancel={onCancel} onSuspend={vi.fn()} />,
      )

      stdin.write('env')
      await settle()
      stdin.write('\x1A')
      await settle()

      expect(onCancel).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
      expect(lastFrame() ?? '').toContain('env-status')
    })

    it('is an inert no-op when suspend is unavailable — and never types a "z" into the filter', async () => {
      const { lastFrame, stdin } = render(<CommandPalette items={items} onSelect={vi.fn()} onCancel={vi.fn()} />)

      stdin.write('\x1A')
      await settle()

      // The filter is untouched, so every command still shows.
      expect(lastFrame() ?? '').toContain('release-list')
      expect(lastFrame() ?? '').toContain('env-status')
    })

    it('advertises ctrl-z in the hint only where suspending is possible', () => {
      const withSuspend = render(
        <CommandPalette items={items} onSelect={vi.fn()} onCancel={vi.fn()} onSuspend={vi.fn()} />,
      )
      const without = render(<CommandPalette items={items} onSelect={vi.fn()} onCancel={vi.fn()} />)

      expect(withSuspend.lastFrame() ?? '').toContain('Ctrl-Z')
      expect(without.lastFrame() ?? '').not.toContain('Ctrl-Z')
    })
  })
})
