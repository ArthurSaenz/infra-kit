import { beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'

import { logRemovalResults } from '../log-removal-results'

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const infoLines = (): string[] => {
  return vi.mocked(logger.info).mock.calls.map((call) => {
    return String(call[0])
  })
}

const warnLines = (): string[] => {
  return vi.mocked(logger.warn).mock.calls.map((call) => {
    return String(call[0])
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('logRemovalResults', () => {
  it('lists removed branches at info level', () => {
    logRemovalResults({ removed: ['release/v1.2.5', 'release/v1.2.6'], failed: [] })

    expect(infoLines()).toEqual(['❌ Removed worktrees:', 'release/v1.2.5', 'release/v1.2.6', ''])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('lists every failed branch WITH its reason at warn level — never as "nothing to do"', () => {
    logRemovalResults({
      removed: ['release/v1.2.5'],
      failed: [{ branch: 'release/v1.2.6', reason: 'fatal: contains modified or untracked files' }],
    })

    expect(infoLines()).toEqual(['❌ Removed worktrees:', 'release/v1.2.5', ''])
    expect(warnLines()).toEqual(['⚠️ Not removed:', 'release/v1.2.6 — fatal: contains modified or untracked files', ''])
    expect([...infoLines(), ...warnLines()].join('\n')).not.toMatch(/No (unused )?worktrees to remove/)
  })

  it('prints a single "nothing to remove" line only when nothing was attempted', () => {
    logRemovalResults({ removed: [], failed: [] })

    expect(infoLines()).toEqual(['ℹ️ No worktrees to remove'])
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
