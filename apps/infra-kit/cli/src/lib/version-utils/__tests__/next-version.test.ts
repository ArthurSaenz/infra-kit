import { describe, expect, it } from 'vitest'

import {
  NoPriorVersionsError,
  collectKnownVersions,
  computeNextVersion,
  resolveVersionTokens,
  splitVersionInput,
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

describe('resolveVersionTokens', () => {
  const known = collectKnownVersions({ remoteBranches: ['release/v1.63.0'] })

  it('resolves "next,next" sequentially for regular', () => {
    expect(resolveVersionTokens(['next', 'next'], 'regular', known)).toEqual(['1.64.0', '1.65.0'])
  })

  it('mixes literals and next, advancing running max', () => {
    expect(resolveVersionTokens(['next', '1.70.0', 'next'], 'regular', known)).toEqual(['1.64.0', '1.70.0', '1.71.0'])
  })

  it('accepts NEXT and " next " (case + whitespace insensitive)', () => {
    expect(resolveVersionTokens(['NEXT', ' next '], 'regular', known)).toEqual(['1.64.0', '1.65.0'])
  })

  it('strips leading v on explicit versions', () => {
    expect(resolveVersionTokens(['v1.70.0'], 'regular', known)).toEqual(['1.70.0'])
  })

  it('throws on invalid token', () => {
    expect(() => {
      return resolveVersionTokens(['nope'], 'regular', known)
    }).toThrow(/Invalid version/)
  })

  it('hotfix sequence advances patch each step', () => {
    expect(resolveVersionTokens(['next', 'next'], 'hotfix', known)).toEqual(['1.63.1', '1.63.2'])
  })
})

describe('splitVersionInput', () => {
  it('splits comma-separated input and trims', () => {
    expect(splitVersionInput(' 1.2.3 , next, ,1.2.4 ')).toEqual(['1.2.3', 'next', '1.2.4'])
  })

  it('returns empty array for empty input', () => {
    expect(splitVersionInput('')).toEqual([])
    expect(splitVersionInput('   ')).toEqual([])
  })
})
