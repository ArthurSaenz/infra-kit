import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRs, getReleasePRsWithInfo } from '../gh-release-prs'

interface FakePR {
  number: number
  title: string
  headRefName: string
  state: string
  baseRefName: string
  createdAt: string
}

const responses = vi.hoisted(() => {
  return { release: [] as FakePR[], hotfix: [] as FakePR[] }
})

// Mock zx's tagged-template `$`: the gh pr list call for `--base dev` returns
// the "release" set, `--base main` returns the "hotfix" set. The command is
// reconstructed from the template strings so we can branch on the base flag.
vi.mock('zx', () => {
  return {
    $: vi.fn((strings: TemplateStringsArray) => {
      const command = strings.join('')

      if (command.includes('--base main')) {
        return Promise.resolve({ stdout: JSON.stringify(responses.hotfix) })
      }

      return Promise.resolve({ stdout: JSON.stringify(responses.release) })
    }),
  }
})

const pr = (overrides: Partial<FakePR> & Pick<FakePR, 'headRefName' | 'createdAt'>): FakePR => {
  return {
    number: 1,
    title: 'Release',
    state: 'OPEN',
    baseRefName: 'dev',
    ...overrides,
  }
}

describe('getReleasePRs (discovery + sort)', () => {
  beforeEach(() => {
    responses.release = []
    responses.hotfix = []
  })

  it('sorts version branches first by semver ascending (numeric, 1.9.0 < 1.10.0), then names by createdAt', async () => {
    responses.release = [
      pr({ headRefName: 'release/n/zeta-feature', createdAt: '2026-01-10T00:00:00Z', title: 'Release zeta-feature' }),
      pr({ headRefName: 'release/v1.10.0', createdAt: '2026-01-02T00:00:00Z' }),
      pr({ headRefName: 'release/n/alpha-feature', createdAt: '2026-01-05T00:00:00Z', title: 'Release alpha-feature' }),
      pr({ headRefName: 'release/v1.9.0', createdAt: '2026-01-01T00:00:00Z' }),
    ]

    await expect(getReleasePRs()).resolves.toEqual([
      'release/v1.9.0',
      'release/v1.10.0',
      'release/n/alpha-feature',
      'release/n/zeta-feature',
    ])
  })

  it('filters out unparseable junk branches instead of throwing or NaN-sorting', async () => {
    responses.release = [
      pr({ headRefName: 'release/garbage', createdAt: '2026-01-01T00:00:00Z' }),
      pr({ headRefName: 'release/v1.2.3', createdAt: '2026-01-02T00:00:00Z' }),
      pr({ headRefName: 'totally-not-a-release', createdAt: '2026-01-03T00:00:00Z' }),
      pr({
        headRefName: 'release/n/checkout-redesign',
        createdAt: '2026-01-04T00:00:00Z',
        title: 'Release checkout-redesign',
      }),
    ]

    await expect(getReleasePRs()).resolves.toEqual(['release/v1.2.3', 'release/n/checkout-redesign'])
  })

  it('merges hotfix (base main) and release (base dev) sets', async () => {
    responses.release = [pr({ headRefName: 'release/v2.0.0', createdAt: '2026-01-01T00:00:00Z' })]
    responses.hotfix = [
      pr({
        headRefName: 'release/v1.9.9',
        createdAt: '2026-01-02T00:00:00Z',
        baseRefName: 'main',
        title: 'Hotfix v1.9.9',
      }),
    ]

    await expect(getReleasePRs()).resolves.toEqual(['release/v1.9.9', 'release/v2.0.0'])
  })
})

describe('getReleasePRsWithInfo (discovery + sort)', () => {
  beforeEach(() => {
    responses.release = []
    responses.hotfix = []
  })

  it('returns branch/title/createdAt in the locked order with junk filtered', async () => {
    responses.release = [
      pr({ headRefName: 'release/n/beta-feature', createdAt: '2026-02-02T00:00:00Z', title: 'Release beta-feature' }),
      pr({ headRefName: 'release/garbage', createdAt: '2026-02-03T00:00:00Z', title: 'Release garbage' }),
      pr({ headRefName: 'release/v3.1.0', createdAt: '2026-02-01T00:00:00Z', title: 'Release v3.1.0' }),
    ]

    await expect(getReleasePRsWithInfo()).resolves.toEqual([
      { branch: 'release/v3.1.0', title: 'Release v3.1.0', createdAt: '2026-02-01T00:00:00Z' },
      { branch: 'release/n/beta-feature', title: 'Release beta-feature', createdAt: '2026-02-02T00:00:00Z' },
    ])
  })
})
