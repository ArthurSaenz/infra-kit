import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getJiraDescriptions, getJiraVersionInfo } from '../release-utils'

/**
 * @fileoverview
 * Both lookups are decoration for listings that await them inside a `Promise.all`, so the contract
 * under test is "never throws": no Jira config → empty map, a failing fetch → warn and return what
 * was gathered. `getJiraDescriptions` is a projection of `getJiraVersionInfo` and must keep its
 * pre-existing shape — only versions WITH a description get an entry.
 */

const mocks = vi.hoisted(() => {
  return {
    loadJiraConfigOptional: vi.fn(),
    getProjectVersions: vi.fn(),
    warn: vi.fn(),
  }
})

vi.mock('src/integrations/jira', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/jira')>()

  return {
    ...actual,
    loadJiraConfigOptional: mocks.loadJiraConfigOptional,
    getProjectVersions: mocks.getProjectVersions,
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: mocks.warn } }
})

const jiraConfig = { baseUrl: 'https://jira.example.com', token: 't', email: 'e@example.com', projectId: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadJiraConfigOptional.mockResolvedValue(jiraConfig)
})

describe('getJiraVersionInfo', () => {
  it('maps every version by name with null for a missing description or date', async () => {
    mocks.getProjectVersions.mockResolvedValue([
      { name: 'v1.2.3', description: 'Cart fixes', releaseDate: '2026-10-28' },
      { name: 'checkout-redesign', description: '', releaseDate: undefined },
    ])

    const info = await getJiraVersionInfo()

    expect([...info]).toEqual([
      ['v1.2.3', { description: 'Cart fixes', releaseDate: '2026-10-28' }],
      ['checkout-redesign', { description: null, releaseDate: null }],
    ])
    expect(mocks.getProjectVersions).toHaveBeenCalledTimes(1)
  })

  it('returns an empty map without a fetch when Jira is not configured', async () => {
    mocks.loadJiraConfigOptional.mockResolvedValue(null)

    expect((await getJiraVersionInfo()).size).toBe(0)
    expect(mocks.getProjectVersions).not.toHaveBeenCalled()
  })

  it('warns and returns an empty map when the fetch throws', async () => {
    mocks.getProjectVersions.mockRejectedValue(new Error('401'))

    expect((await getJiraVersionInfo()).size).toBe(0)
    expect(mocks.warn).toHaveBeenCalledTimes(1)
  })
})

describe('getJiraDescriptions', () => {
  it('projects only the versions that have a description', async () => {
    mocks.getProjectVersions.mockResolvedValue([
      { name: 'v1.2.3', description: 'Cart fixes', releaseDate: '2026-10-28' },
      { name: 'checkout-redesign', description: '' },
    ])

    expect([...(await getJiraDescriptions())]).toEqual([['v1.2.3', 'Cart fixes']])
  })

  it('returns an empty map when the fetch throws', async () => {
    mocks.getProjectVersions.mockRejectedValue(new Error('401'))

    expect((await getJiraDescriptions()).size).toBe(0)
    expect(mocks.warn).toHaveBeenCalledTimes(1)
  })
})
