import { beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'

import { commandEcho } from '../command-echo'

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const infoMock = vi.mocked(logger.info)

// The single printed argument, or undefined when print() emitted nothing.
const printedLine = (): string | undefined => {
  return infoMock.mock.calls[0]?.[0] as string | undefined
}

beforeEach(() => {
  commandEcho.reset()
  infoMock.mockClear()
})

describe('commandEcho.print', () => {
  it('emits nothing when the command was not interactive', () => {
    commandEcho.start('release-create')
    commandEcho.addOption('--yes', true)

    commandEcho.print()

    expect(infoMock).not.toHaveBeenCalled()
  })

  it('emits nothing when interactive but no options were recorded', () => {
    commandEcho.start('release-create')
    commandEcho.setInteractive()

    commandEcho.print()

    expect(infoMock).not.toHaveBeenCalled()
  })

  it('renders a boolean true option as a bare flag and omits boolean false', () => {
    commandEcho.start('release-create')
    commandEcho.setInteractive()
    commandEcho.addOption('--yes', true)
    commandEcho.addOption('--all', false)

    commandEcho.print()

    const line = printedLine()

    expect(line).toContain('--yes')
    expect(line).not.toContain('--all')
  })

  it('quotes a string option value', () => {
    commandEcho.start('release-create')
    commandEcho.setInteractive()
    commandEcho.addOption('--release', 'checkout-redesign:regular:Q3 work')

    commandEcho.print()

    expect(printedLine()).toContain('--release "checkout-redesign:regular:Q3 work"')
  })

  it('joins and quotes an array option value', () => {
    commandEcho.start('gh-merge-dev')
    commandEcho.setInteractive()
    commandEcho.addOption('--versions', ['1.2.5', '1.3.0'])

    commandEcho.print()

    expect(printedLine()).toContain('--versions "1.2.5, 1.3.0"')
  })

  it('formats the full equivalent command and round-trips the release description', () => {
    commandEcho.start('release-create')
    commandEcho.setInteractive()
    commandEcho.addOption('--release', 'sponsored-banners-scroll-fix:regular:Fix scroll bug in results pages')
    commandEcho.addOption('--yes', true)

    commandEcho.print()

    expect(printedLine()).toBe(
      '📟 Equivalent command: \npnpm exec infra-kit release-create --release "sponsored-banners-scroll-fix:regular:Fix scroll bug in results pages" --yes\n',
    )
  })

  it('preserves option order and drops false-valued flags from the middle', () => {
    commandEcho.start('release-create')
    commandEcho.setInteractive()
    commandEcho.addOption('--release', 'one')
    commandEcho.addOption('--all', false)
    commandEcho.addOption('--yes', true)

    commandEcho.print()

    expect(printedLine()).toBe('📟 Equivalent command: \npnpm exec infra-kit release-create --release "one" --yes\n')
  })
})

describe('commandEcho lifecycle', () => {
  it('start() clears options and interactive state from a prior command', () => {
    commandEcho.start('release-create')
    commandEcho.setInteractive()
    commandEcho.addOption('--release', 'stale')

    commandEcho.start('worktrees-add')
    commandEcho.addOption('--versions', ['1.0.0'])

    commandEcho.print()

    // start() reset isInteractive to false, so print() stays silent.
    expect(infoMock).not.toHaveBeenCalled()
  })

  it('reset() clears all state so a later print() emits nothing', () => {
    commandEcho.start('release-create')
    commandEcho.setInteractive()
    commandEcho.addOption('--yes', true)

    commandEcho.reset()
    commandEcho.print()

    expect(infoMock).not.toHaveBeenCalled()
  })
})
