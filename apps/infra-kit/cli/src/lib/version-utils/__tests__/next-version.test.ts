import { describe, expect, it } from 'vitest'

import { InvalidReleaseNameError, formatBranchName, formatJiraName, formatPrTitle } from '../../release-id'
import type { ReleaseId } from '../../release-id'
import {
  NoPriorVersionsError,
  collectKnownVersions,
  computeNextVersion,
  hasNextToken,
  parseReleaseSpec,
  resolveReleaseEntries,
} from '../next-version'
import type { ReleaseEntry } from '../next-version'

const versionId = (raw: string): ReleaseId => {
  const [major, minor, patch] = raw.split('.').map(Number)

  return { kind: 'version', semver: { major: major!, minor: minor!, patch: patch! }, raw }
}

const nameId = (name: string): ReleaseId => {
  return { kind: 'name', name, raw: name }
}

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

  it('passes through explicit semver entries, wrapping them in a version ReleaseId', () => {
    expect(
      resolveReleaseEntries(
        [
          { version: '1.70.0', type: 'regular' },
          { version: 'v1.70.1', type: 'hotfix' },
        ],
        known,
      ),
    ).toEqual([
      { id: versionId('1.70.0'), type: 'regular' },
      { id: versionId('1.70.1'), type: 'hotfix' },
    ])
  })

  it('resolves a single "next" using the entry type', () => {
    expect(resolveReleaseEntries([{ version: 'next', type: 'regular' }], known)).toEqual([
      { id: versionId('1.64.0'), type: 'regular' },
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
      { id: versionId('1.64.0'), type: 'regular' },
      { id: versionId('1.65.0'), type: 'regular' },
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
      { id: versionId('1.64.0'), type: 'regular' },
      { id: versionId('1.64.1'), type: 'hotfix' },
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
      { id: versionId('1.64.0'), type: 'regular' },
      { id: versionId('1.70.0'), type: 'regular' },
      { id: versionId('1.71.0'), type: 'regular' },
    ])
  })

  it('preserves description through resolution', () => {
    expect(resolveReleaseEntries([{ version: 'next', type: 'regular', description: 'Holiday' }], known)).toEqual([
      { id: versionId('1.64.0'), type: 'regular', description: 'Holiday' },
    ])
  })

  it('accepts case-insensitive "next"', () => {
    expect(resolveReleaseEntries([{ version: 'NEXT', type: 'regular' }], known)).toEqual([
      { id: versionId('1.64.0'), type: 'regular' },
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

  describe('named entries', () => {
    it('resolves a valid name into a name ReleaseId', () => {
      expect(resolveReleaseEntries([{ name: 'checkout-redesign', type: 'regular' }], known)).toEqual([
        { id: nameId('checkout-redesign'), type: 'regular' },
      ])
    })

    it('preserves type and description on named entries (named hotfix allowed)', () => {
      expect(
        resolveReleaseEntries([{ name: 'checkout-redesign', type: 'hotfix', description: 'Q3 work' }], known),
      ).toEqual([{ id: nameId('checkout-redesign'), type: 'hotfix', description: 'Q3 work' }])
    })

    it('never auto-bumps a named entry (no version interaction)', () => {
      expect(
        resolveReleaseEntries(
          [
            { name: 'first-thing', type: 'regular' },
            { version: 'next', type: 'regular' },
          ],
          known,
        ),
      ).toEqual([
        { id: nameId('first-thing'), type: 'regular' },
        { id: versionId('1.64.0'), type: 'regular' },
      ])
    })

    it('throws InvalidReleaseNameError on an invalid (non-kebab) name', () => {
      expect(() => {
        return resolveReleaseEntries([{ name: 'Checkout_Redesign', type: 'regular' }], known)
      }).toThrow(InvalidReleaseNameError)
    })

    it('throws InvalidReleaseNameError when the name is the reserved word "next"', () => {
      expect(() => {
        return resolveReleaseEntries([{ name: 'next', type: 'regular' }], known)
      }).toThrow(InvalidReleaseNameError)
    })
  })

  describe('formatting round-trip (zero-regression for versioned, correct for named)', () => {
    const resolve = (entry: Parameters<typeof resolveReleaseEntries>[0][number]): ReleaseEntry => {
      return resolveReleaseEntries([entry], known)[0] as ReleaseEntry
    }

    it('versioned literal "1.62.0" produces byte-identical branch/PR/Jira output', () => {
      const { id } = resolve({ version: '1.62.0', type: 'regular' })

      expect(formatBranchName(id)).toBe('release/v1.62.0')
      expect(formatPrTitle(id, 'regular')).toBe('Release v1.62.0')
      expect(formatJiraName(id)).toBe('v1.62.0')
    })

    it('versioned "next" resolves then formats identically to the equivalent literal', () => {
      const { id } = resolve({ version: 'next', type: 'regular' })

      // known max is 1.63.0 → regular next is 1.64.0
      expect(formatBranchName(id)).toBe('release/v1.64.0')
      expect(formatPrTitle(id, 'hotfix')).toBe('Hotfix v1.64.0')
      expect(formatJiraName(id)).toBe('v1.64.0')
    })

    it('named entry produces the named branch/PR/Jira output', () => {
      const { id } = resolve({ name: 'checkout-redesign', type: 'regular' })

      expect(formatBranchName(id)).toBe('release/n/checkout-redesign')
      expect(formatPrTitle(id, 'regular')).toBe('Release checkout-redesign')
      expect(formatJiraName(id)).toBe('checkout-redesign')
    })
  })
})

describe('hasNextToken', () => {
  it('is true when any versioned entry is "next"', () => {
    expect(
      hasNextToken([
        { name: 'checkout-redesign', type: 'regular' },
        { version: 'next', type: 'regular' },
      ]),
    ).toBe(true)
  })

  it('is false for explicit versions and named entries only', () => {
    expect(
      hasNextToken([
        { version: '1.2.3', type: 'regular' },
        { name: 'next-thing', type: 'regular' },
      ]),
    ).toBe(false)
  })
})
