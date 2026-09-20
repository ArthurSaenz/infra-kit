import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReleasePRInfo } from 'src/integrations/gh'

import { ghReleaseList } from '../gh-release-list'

/**
 * @fileoverview
 * `titleMismatch` is carried from discovery (`releaseTypeFromBase` vs `detectReleaseType`) straight
 * through to both the `--json` row and the human line — this pins that it survives the trip and
 * that a mismatching row gets the `⚠` marker a plain row does not.
 *
 * The Jira decoration (description + planned release date) is optional per row and absent as a
 * whole when Jira is unreachable; both shapes must still render every release.
 */

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/lib/release-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/release-utils')>()

  return { ...actual, getJiraVersionInfo: vi.fn() }
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
    const { getJiraVersionInfo } = await import('src/lib/release-utils')
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
    vi.mocked(getJiraVersionInfo).mockResolvedValue(new Map())

    const result = await ghReleaseList()

    expect(result.structuredContent.releases).toEqual([
      { version: '1.2.3', type: 'hotfix', description: null, releaseDate: null, titleMismatch: true },
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
    const { getJiraVersionInfo } = await import('src/lib/release-utils')
    const { logger } = await import('src/lib/logger')

    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([releasePRInfo({})])
    vi.mocked(getJiraVersionInfo).mockResolvedValue(new Map())

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

describe('gh-release-list — Jira release date', () => {
  const printedLines = async () => {
    const { logger } = await import('src/lib/logger')

    return vi.mocked(logger.info).mock.calls.map(([line]) => {
      return line as string
    })
  }

  const listWith = async (jira: Map<string, { description: string | null; releaseDate: string | null }>) => {
    const { getReleasePRsWithInfo } = await import('src/integrations/gh')
    const { getJiraVersionInfo } = await import('src/lib/release-utils')

    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([
      releasePRInfo({}),
      releasePRInfo({ branch: 'release/checkout-redesign', number: 2, title: 'Release checkout-redesign' }),
    ])
    vi.mocked(getJiraVersionInfo).mockResolvedValue(jira)

    return ghReleaseList()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('appends "· ships <date>" after the description and carries the date in structuredContent', async () => {
    const result = await listWith(
      new Map([
        ['v1.2.3', { description: 'Cart fixes', releaseDate: '2026-10-28' }],
        ['checkout-redesign', { description: null, releaseDate: '2026-11-02' }],
      ]),
    )

    expect(result.structuredContent.releases).toEqual([
      { version: '1.2.3', type: 'regular', description: 'Cart fixes', releaseDate: '2026-10-28', titleMismatch: false },
      {
        version: 'checkout-redesign',
        type: 'regular',
        description: null,
        releaseDate: '2026-11-02',
        titleMismatch: false,
      },
    ])

    const lines = await printedLines()

    expect(
      lines.some((line) => {
        return line.includes('Cart fixes · ships 2026-10-28')
      }),
    ).toBe(true)
    expect(
      lines.some((line) => {
        return line.includes('[regular]   · ships 2026-11-02')
      }),
    ).toBe(true)
  })

  it('keeps the mismatch marker after the date', async () => {
    const { getReleasePRsWithInfo } = await import('src/integrations/gh')
    const { getJiraVersionInfo } = await import('src/lib/release-utils')

    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([
      releasePRInfo({ title: '🔥 Hotfix v1.2.3', baseRefName: 'main', type: 'hotfix', titleMismatch: true }),
    ])
    vi.mocked(getJiraVersionInfo).mockResolvedValue(
      new Map([['v1.2.3', { description: 'Cart fixes', releaseDate: '2026-10-28' }]]),
    )

    await ghReleaseList()

    const lines = await printedLines()

    expect(
      lines.some((line) => {
        return line.includes('Cart fixes · ships 2026-10-28 ⚠ title/base mismatch')
      }),
    ).toBe(true)
  })

  it('renders no "ships" segment and releaseDate null when the Jira version has no date', async () => {
    const result = await listWith(
      new Map([
        ['v1.2.3', { description: 'Cart fixes', releaseDate: null }],
        ['checkout-redesign', { description: null, releaseDate: null }],
      ]),
    )

    expect(
      result.structuredContent.releases.map((release) => {
        return release.releaseDate
      }),
    ).toEqual([null, null])

    const lines = await printedLines()

    expect(
      lines.some((line) => {
        return line.includes('ships')
      }),
    ).toBe(false)
    expect(
      lines.some((line) => {
        return line.includes('Cart fixes')
      }),
    ).toBe(true)
  })

  it('still renders every row with description and releaseDate null when Jira is unavailable', async () => {
    // `getJiraVersionInfo` never throws — an unreachable Jira resolves to an empty map.
    const result = await listWith(new Map())

    expect(result.structuredContent.releases).toEqual([
      { version: '1.2.3', type: 'regular', description: null, releaseDate: null, titleMismatch: false },
      { version: 'checkout-redesign', type: 'regular', description: null, releaseDate: null, titleMismatch: false },
    ])
    expect(result.structuredContent.count).toBe(2)

    const lines = await printedLines()

    expect(
      lines.some((line) => {
        return line.includes('1.2.3')
      }),
    ).toBe(true)
    expect(
      lines.some((line) => {
        return line.includes('checkout-redesign')
      }),
    ).toBe(true)
  })
})
