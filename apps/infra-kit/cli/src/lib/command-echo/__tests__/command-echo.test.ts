import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
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
    commandEcho.start('release create')
    commandEcho.addOption('--yes', true)

    commandEcho.print()

    expect(infoMock).not.toHaveBeenCalled()
  })

  it('emits nothing when interactive but no options were recorded', () => {
    commandEcho.start('release create')
    commandEcho.setInteractive()

    commandEcho.print()

    expect(infoMock).not.toHaveBeenCalled()
  })

  // An echo nobody bound to a command ran off the CLI (an MCP tool). Without this guard it would print
  // `pnpm exec infra-kit  --yes` — a command with no command in it.
  it('emits nothing when no command path was bound, however complete the recording is', () => {
    commandEcho.setInteractive()
    commandEcho.addOption('--yes', true)

    commandEcho.print()

    expect(infoMock).not.toHaveBeenCalled()
  })

  it('renders a boolean true option as a bare flag and omits boolean false', () => {
    commandEcho.start('release create')
    commandEcho.setInteractive()
    commandEcho.addOption('--yes', true)
    commandEcho.addOption('--all', false)

    commandEcho.print()

    const line = printedLine()

    expect(line).toContain('--yes')
    expect(line).not.toContain('--all')
  })

  it('quotes a string option value', () => {
    commandEcho.start('release create')
    commandEcho.setInteractive()
    commandEcho.addOption('--release', 'checkout-redesign:regular:Q3 work')

    commandEcho.print()

    expect(printedLine()).toContain('--release "checkout-redesign:regular:Q3 work"')
  })

  it('joins and quotes an array option value', () => {
    commandEcho.start('release merge-dev')
    commandEcho.setInteractive()
    commandEcho.addOption('--versions', ['1.2.5', '1.3.0'])

    commandEcho.print()

    expect(printedLine()).toContain('--versions "1.2.5, 1.3.0"')
  })

  // The grouped path is printed VERBATIM, spaces and all, because it is the argv Commander parsed. The
  // flat `release-create` this used to print stopped being a command when the flat aliases were dropped.
  it('formats the full equivalent command and round-trips the release description', () => {
    commandEcho.start('release create')
    commandEcho.setInteractive()
    commandEcho.addOption('--release', 'sponsored-banners-scroll-fix:regular:Fix scroll bug in results pages')
    commandEcho.addOption('--yes', true)

    commandEcho.print()

    expect(printedLine()).toBe(
      '📟 Equivalent command: \npnpm exec infra-kit release create --release "sponsored-banners-scroll-fix:regular:Fix scroll bug in results pages" --yes\n',
    )
  })

  it('preserves option order and drops false-valued flags from the middle', () => {
    commandEcho.start('release create')
    commandEcho.setInteractive()
    commandEcho.addOption('--release', 'one')
    commandEcho.addOption('--all', false)
    commandEcho.addOption('--yes', true)

    commandEcho.print()

    expect(printedLine()).toBe('📟 Equivalent command: \npnpm exec infra-kit release create --release "one" --yes\n')
  })
})

describe('commandEcho lifecycle', () => {
  it('start() clears options and interactive state from a prior command', () => {
    commandEcho.start('release create')
    commandEcho.setInteractive()
    commandEcho.addOption('--release', 'stale')

    commandEcho.start('worktrees add')
    commandEcho.addOption('--versions', ['1.0.0'])

    commandEcho.print()

    // start() reset isInteractive to false, so print() stays silent.
    expect(infoMock).not.toHaveBeenCalled()
  })

  it('reset() clears all state so a later print() emits nothing', () => {
    commandEcho.start('release create')
    commandEcho.setInteractive()
    commandEcho.addOption('--yes', true)

    commandEcho.reset()
    commandEcho.print()

    expect(infoMock).not.toHaveBeenCalled()
  })
})

/** Every `.ts` file under `src`, excluding tests. */
const sourceFiles = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full)

    return entry.isFile() && full.endsWith('.ts') ? [full] : []
  })
}

describe('commandEcho ownership', () => {
  /**
   * A source-level guard, because the defect it prevents is invisible to a behavioural test: a command
   * that names its own echo compiles, passes its own tests, and prints a `pnpm exec` line that the CLI
   * rejects — which is exactly how `release-create` survived the removal of the flat aliases.
   *
   * Only Commander knows the argv it parsed, so only program.ts's `preAction` may call `start()`. The
   * scan is over the source tree rather than a list of known commands, so a NEW command that reintroduces
   * the habit fails here without anyone remembering to add it.
   */
  it('lets nothing but program.ts bind a command path', () => {
    const src = path.resolve(__dirname, '../../..')

    const offenders = sourceFiles(src).filter((file) => {
      return /commandEcho\.start\(/u.test(readFileSync(file, 'utf8')) && !file.endsWith('lib/program/program.ts')
    })

    const relative = offenders.map((file) => {
      return path.relative(src, file)
    })

    expect(relative).toEqual([])
  })
})
