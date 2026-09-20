import { describe, expect, it, vi } from 'vitest'

import type { ReleasePRInfo } from 'src/integrations/gh'

import { ghReleaseList } from '../gh-release-list'

/**
 * @fileoverview
 * `titleMismatch` is carried from discovery (`releaseTypeFromBase` vs `detectReleaseType`) straight
 * through to both the `--json` row and the human line — this pins that it survives the trip and
 * that a mismatching row gets the `⚠` marker a plain row does not.
 */

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/lib/release-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/release-utils')>()

  return { ...actual, getJiraDescriptions: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }
})

const releasePRInfo = (overrides: Partial<ReleasePRInfo>): ReleasePRInfo => {
  return {
    branch: 'release/v1.2.3',
    number: 1,
    title: 'Release v1.2.3',
    createdAt: '2026-01-01T00:00:00Z',
    baseRefName: 'dev',
    type: 'regular',
    titleMismatch: false,
    dualBase: false,
    ...overrides,
  }
}

describe('gh-release-list — titleMismatch', () => {
  it('flags a retitled hotfix as titleMismatch true in structuredContent and marks its printed line', async () => {
    const { getReleasePRsWithInfo } = await import('src/integrations/gh')
    const { getJiraDescriptions } = await import('src/lib/release-utils')
    const { logger } = await import('src/lib/logger')

    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([
      releasePRInfo({
        branch: 'release/v1.2.3',
        title: '🔥 Hotfix v1.2.3',
        baseRefName: 'main',
        type: 'hotfix',
        titleMismatch: true,
      }),
    ])
    vi.mocked(getJiraDescriptions).mockResolvedValue(new Map())

    const result = await ghReleaseList()

    expect(result.structuredContent.releases).toEqual([
      { version: '1.2.3', type: 'hotfix', description: null, titleMismatch: true },
    ])

    const printedLines = vi.mocked(logger.info).mock.calls.map(([line]) => {
      return line as string
    })

    expect(
      printedLines.some((line) => {
        return line.includes('⚠ title/base mismatch')
      }),
    ).toBe(true)
  })

  it('does not mark a row whose title agrees with its base', async () => {
    const { getReleasePRsWithInfo } = await import('src/integrations/gh')
    const { getJiraDescriptions } = await import('src/lib/release-utils')
    const { logger } = await import('src/lib/logger')

    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([releasePRInfo({})])
    vi.mocked(getJiraDescriptions).mockResolvedValue(new Map())

    const result = await ghReleaseList()

    expect(result.structuredContent.releases[0]?.titleMismatch).toBe(false)

    const printedLines = vi.mocked(logger.info).mock.calls.map(([line]) => {
      return line as string
    })

    expect(
      printedLines.some((line) => {
        return line.includes('⚠')
      }),
    ).toBe(false)
  })
})
