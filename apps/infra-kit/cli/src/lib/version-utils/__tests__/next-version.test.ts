import { describe, expect, it } from 'vitest'

import {
  NoPriorVersionsError,
  collectKnownVersions,
  computeNextVersion,
  parseReleaseSpec,
  resolveReleaseEntries,
} from '../next-version'

describe('collectKnownVersions', () => {
  it('parses remote branch refs and Jira version names and dedupes', () => {
    const known = collectKnownVersions({
      remoteBranches: ['release/v1.62.0', 'refs/heads/release/v1.63.0', 'release/v1.62.0'],
      jiraVersions: ['v1.63.0', 'v1.64.5'],
    })

    expect(known).toEqual([
      [1, 62, 0],
      [1, 63, 0],
      [1, 64, 5],
    ])
  })

  it('ignores non-semver inputs', () => {
    const known = collectKnownVersions({
      remoteBranches: ['release/v1.62.0', 'release/v-bogus', 'main'],
      jiraVersions: ['v1.63.0', 'random-name'],
    })

    expect(known).toEqual([
      [1, 62, 0],
      [1, 63, 0],
    ])
  })

  it('returns [] when sources are empty or undefined', () => {
    expect(collectKnownVersions({})).toEqual([])
    expect(collectKnownVersions({ remoteBranches: [], jiraVersions: [] })).toEqual([])
  })
})

describe('computeNextVersion', () => {
  it('regular bumps minor and resets patch', () => {
    const known = collectKnownVersions({ remoteBranches: ['release/v1.63.5', 'release/v1.62.0'] })

    expect(computeNextVersion(known, 'regular')).toBe('1.64.0')
  })

  it('hotfix bumps patch on the highest minor (any patch)', () => {
    const known = collectKnownVersions({
      remoteBranches: ['release/v1.63.5', 'release/v1.63.0', 'release/v1.62.0'],
    })

    expect(computeNextVersion(known, 'hotfix')).toBe('1.63.6')
  })

  it('hotfix uses the highest minor even when patch chain has gaps', () => {
    const known = collectKnownVersions({
      remoteBranches: ['release/v1.55.10', 'release/v1.55.20', 'release/v1.55.30'],
    })

    expect(computeNextVersion(known, 'hotfix')).toBe('1.55.31')
  })

  it('throws NoPriorVersionsError when there are no known versions', () => {
    expect(() => {
      return computeNextVersion([], 'regular')
    }).toThrow(NoPriorVersionsError)
  })
})

describe('parseReleaseSpec', () => {
  it('parses bare version as regular with no description', () => {
    expect(parseReleaseSpec('1.2.5')).toEqual({ version: '1.2.5', type: 'regular' })
  })

  it('parses version:type', () => {
    expect(parseReleaseSpec('1.2.5:hotfix')).toEqual({ version: '1.2.5', type: 'hotfix' })
  })

  it('parses version:type:description', () => {
    expect(parseReleaseSpec('1.2.5:regular:Holiday backend')).toEqual({
      version: '1.2.5',
      type: 'regular',
      description: 'Holiday backend',
    })
  })

  it('preserves colons inside the description', () => {
    expect(parseReleaseSpec('1.2.5:regular:Fixes: A and B')).toEqual({
      version: '1.2.5',
      type: 'regular',
      description: 'Fixes: A and B',
    })
  })

  it('accepts the literal "next" token', () => {
    expect(parseReleaseSpec('next:hotfix')).toEqual({ version: 'next', type: 'hotfix' })
  })

  it('lowercases the type', () => {
    expect(parseReleaseSpec('1.2.5:HOTFIX')).toEqual({ version: '1.2.5', type: 'hotfix' })
  })

  it('drops empty description', () => {
    expect(parseReleaseSpec('1.2.5:regular:')).toEqual({ version: '1.2.5', type: 'regular' })
  })

  it('throws on unknown type', () => {
    expect(() => {
      return parseReleaseSpec('1.2.5:major')
    }).toThrow(/Invalid release type/)
  })

  it('throws on empty spec', () => {
    expect(() => {
      return parseReleaseSpec('   ')
    }).toThrow(/empty/)
  })
})

describe('resolveReleaseEntries', () => {
  const known = collectKnownVersions({ remoteBranches: ['release/v1.63.0'] })

  it('passes through explicit semver entries unchanged', () => {
    expect(
      resolveReleaseEntries(
        [
          { version: '1.70.0', type: 'regular' },
          { version: 'v1.70.1', type: 'hotfix' },
        ],
        known,
      ),
    ).toEqual([
      { version: '1.70.0', type: 'regular' },
      { version: '1.70.1', type: 'hotfix' },
    ])
  })

  it('resolves a single "next" using the entry type', () => {
    expect(resolveReleaseEntries([{ version: 'next', type: 'regular' }], known)).toEqual([
      { version: '1.64.0', type: 'regular' },
    ])
  })

  it('advances sequential "next" tokens of the same type', () => {
    expect(
      resolveReleaseEntries(
        [
          { version: 'next', type: 'regular' },
          { version: 'next', type: 'regular' },
        ],
        known,
      ),
    ).toEqual([
      { version: '1.64.0', type: 'regular' },
      { version: '1.65.0', type: 'regular' },
    ])
  })

  it('advances sequential "next" tokens across mixed types', () => {
    expect(
      resolveReleaseEntries(
        [
          { version: 'next', type: 'regular' },
          { version: 'next', type: 'hotfix' },
        ],
        known,
      ),
    ).toEqual([
      { version: '1.64.0', type: 'regular' },
      { version: '1.64.1', type: 'hotfix' },
    ])
  })

  it('mixes literals and "next", advancing the running max', () => {
    expect(
      resolveReleaseEntries(
        [
          { version: 'next', type: 'regular' },
          { version: '1.70.0', type: 'regular' },
          { version: 'next', type: 'regular' },
        ],
        known,
      ),
    ).toEqual([
      { version: '1.64.0', type: 'regular' },
      { version: '1.70.0', type: 'regular' },
      { version: '1.71.0', type: 'regular' },
    ])
  })

  it('preserves description through resolution', () => {
    expect(resolveReleaseEntries([{ version: 'next', type: 'regular', description: 'Holiday' }], known)).toEqual([
      { version: '1.64.0', type: 'regular', description: 'Holiday' },
    ])
  })

  it('accepts case-insensitive "next"', () => {
    expect(resolveReleaseEntries([{ version: 'NEXT', type: 'regular' }], known)).toEqual([
      { version: '1.64.0', type: 'regular' },
    ])
  })

  it('throws on invalid version', () => {
    expect(() => {
      return resolveReleaseEntries([{ version: 'nope', type: 'regular' }], known)
    }).toThrow(/Invalid version/)
  })

  it('throws NoPriorVersionsError when "next" with no known versions', () => {
    expect(() => {
      return resolveReleaseEntries([{ version: 'next', type: 'regular' }], [])
    }).toThrow(NoPriorVersionsError)
  })
})
