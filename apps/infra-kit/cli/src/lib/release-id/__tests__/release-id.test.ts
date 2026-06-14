import { describe, expect, it } from 'vitest'

import {
  InvalidReleaseNameError,
  InvalidReleaseRefError,
  compareReleaseIds,
  displayLabel,
  formatBranchName,
  formatJiraName,
  formatPrTitle,
  formatRcTitle,
  isReleaseBranch,
  parseBranchName,
  parseReleaseRef,
  validateName,
} from '../release-id'
import type { ReleaseId } from '../release-id'

const version = (major: number, minor: number, patch: number): ReleaseId => {
  return { kind: 'version', semver: { major, minor, patch }, raw: `${major}.${minor}.${patch}` }
}

const name = (n: string): ReleaseId => {
  return { kind: 'name', name: n, raw: n }
}

describe('parseBranchName', () => {
  it('parses release/v<semver> as a version', () => {
    expect(parseBranchName('release/v1.2.3')).toEqual(version(1, 2, 3))
  })

  it('parses release/n/<name> as a name', () => {
    expect(parseBranchName('release/n/checkout-redesign')).toEqual(name('checkout-redesign'))
  })

  it('strips a leading refs/heads/ prefix for versions and names', () => {
    expect(parseBranchName('refs/heads/release/v2.0.1')).toEqual(version(2, 0, 1))
    expect(parseBranchName('refs/heads/release/n/my-feature')).toEqual(name('my-feature'))
  })

  it('trims surrounding whitespace', () => {
    expect(parseBranchName('  release/v1.0.0  ')).toEqual(version(1, 0, 0))
  })

  it('returns null for non-release branches', () => {
    expect(parseBranchName('feature/x')).toBeNull()
    expect(parseBranchName('main')).toBeNull()
    expect(parseBranchName('dev')).toBeNull()
  })

  it('returns null for junk under the release/ prefix', () => {
    expect(parseBranchName('release/foo')).toBeNull()
    expect(parseBranchName('release/garbage')).toBeNull()
  })

  it('returns null for incomplete version branches', () => {
    expect(parseBranchName('release/v1.2')).toBeNull()
    expect(parseBranchName('release/v1')).toBeNull()
    expect(parseBranchName('release/v1.2.3.4')).toBeNull()
    expect(parseBranchName('release/vfoo')).toBeNull()
  })

  it('returns null for invalid names', () => {
    expect(parseBranchName('release/n/Bad_Name')).toBeNull()
    expect(parseBranchName('release/n/UPPER')).toBeNull()
    expect(parseBranchName('release/n/main')).toBeNull()
    expect(parseBranchName('release/n/')).toBeNull()
  })

  it('never throws on arbitrary input', () => {
    expect(() => {
      return parseBranchName('')
    }).not.toThrow()
    expect(() => {
      return parseBranchName('!!!')
    }).not.toThrow()
    expect(parseBranchName('')).toBeNull()
  })
})

describe('parseReleaseRef', () => {
  it('delegates a release branch ref to parseBranchName', () => {
    expect(parseReleaseRef('release/v1.2.3')).toEqual(version(1, 2, 3))
    expect(parseReleaseRef('release/n/checkout-redesign')).toEqual(name('checkout-redesign'))
    expect(parseReleaseRef('refs/heads/release/v3.4.5')).toEqual(version(3, 4, 5))
  })

  it('throws when a release branch ref is invalid', () => {
    expect(() => {
      return parseReleaseRef('release/garbage')
    }).toThrow(InvalidReleaseRefError)
    expect(() => {
      return parseReleaseRef('release/v1.2')
    }).toThrow(InvalidReleaseRefError)
    expect(() => {
      return parseReleaseRef('release/n/Bad_Name')
    }).toThrow(InvalidReleaseRefError)
  })

  it('parses a bare semver token as a version', () => {
    expect(parseReleaseRef('1.2.3')).toEqual(version(1, 2, 3))
  })

  it('parses a v-prefixed semver token as a version (normalized raw)', () => {
    expect(parseReleaseRef('v1.2.3')).toEqual(version(1, 2, 3))
    expect(parseReleaseRef('v1.2.3').raw).toBe('1.2.3')
  })

  it('parses a kebab name as a name', () => {
    expect(parseReleaseRef('checkout-redesign')).toEqual(name('checkout-redesign'))
  })

  it('throws on the next token (must be resolved before ref parsing)', () => {
    expect(() => {
      return parseReleaseRef('next')
    }).toThrow(InvalidReleaseRefError)
    expect(() => {
      return parseReleaseRef('next')
    }).toThrow(/computeNextVersion/)
  })

  it('throws on an invalid token with the validation reason', () => {
    expect(() => {
      return parseReleaseRef('Bad_Name')
    }).toThrow(InvalidReleaseRefError)
    expect(() => {
      return parseReleaseRef('main')
    }).toThrow(InvalidReleaseRefError)
  })

  it('trims input before classifying', () => {
    expect(parseReleaseRef('  1.2.3  ')).toEqual(version(1, 2, 3))
    expect(parseReleaseRef('  checkout-redesign ')).toEqual(name('checkout-redesign'))
  })
})

describe('validateName', () => {
  it('accepts simple kebab-case names', () => {
    expect(() => {
      return validateName('a')
    }).not.toThrow()
    expect(() => {
      return validateName('a-b-c')
    }).not.toThrow()
    expect(() => {
      return validateName('1-2-3')
    }).not.toThrow()
    expect(() => {
      return validateName('checkout-redesign')
    }).not.toThrow()
  })

  it('rejects non-kebab tokens', () => {
    expect(() => {
      return validateName('-a')
    }).toThrow(InvalidReleaseNameError)
    expect(() => {
      return validateName('a-')
    }).toThrow(InvalidReleaseNameError)
    expect(() => {
      return validateName('a--b')
    }).toThrow(InvalidReleaseNameError)
    expect(() => {
      return validateName('A-b')
    }).toThrow(InvalidReleaseNameError)
    expect(() => {
      return validateName('a_b')
    }).toThrow(InvalidReleaseNameError)
  })

  it('rejects an empty name', () => {
    expect(() => {
      return validateName('')
    }).toThrow(InvalidReleaseNameError)
  })

  it('rejects each reserved word', () => {
    for (const reserved of ['dev', 'main', 'next', 'hotfix', 'regular', 'release']) {
      expect(() => {
        return validateName(reserved)
      }).toThrow(InvalidReleaseNameError)
    }
  })

  it('rejects a name of length 51 but accepts length 50', () => {
    expect(() => {
      return validateName('a'.repeat(50))
    }).not.toThrow()
    expect(() => {
      return validateName('a'.repeat(51))
    }).toThrow(InvalidReleaseNameError)
  })

  it('rejects semver-looking tokens via the kebab rule', () => {
    expect(() => {
      return validateName('1.2.3')
    }).toThrow(InvalidReleaseNameError)
    expect(() => {
      return validateName('v1.2.3')
    }).toThrow(InvalidReleaseNameError)
  })
})

describe('formatBranchName', () => {
  it('formats versions and names', () => {
    expect(formatBranchName(version(1, 2, 3))).toBe('release/v1.2.3')
    expect(formatBranchName(name('checkout-redesign'))).toBe('release/n/checkout-redesign')
  })
})

describe('formatPrTitle', () => {
  it('formats versioned regular and hotfix titles', () => {
    expect(formatPrTitle(version(1, 2, 3), 'regular')).toBe('Release v1.2.3')
    expect(formatPrTitle(version(1, 2, 3), 'hotfix')).toBe('Hotfix v1.2.3')
  })

  it('formats named regular and hotfix titles', () => {
    expect(formatPrTitle(name('checkout-redesign'), 'regular')).toBe('Release checkout-redesign')
    expect(formatPrTitle(name('checkout-redesign'), 'hotfix')).toBe('Hotfix checkout-redesign')
  })
})

describe('formatRcTitle', () => {
  it('formats versioned and named RC titles', () => {
    expect(formatRcTitle(version(1, 2, 3))).toBe('Release v1.2.3 (RC)')
    expect(formatRcTitle(name('checkout-redesign'))).toBe('Release checkout-redesign (RC)')
  })
})

describe('formatJiraName', () => {
  it('formats versioned and named Jira names', () => {
    expect(formatJiraName(version(1, 2, 3))).toBe('v1.2.3')
    expect(formatJiraName(name('checkout-redesign'))).toBe('checkout-redesign')
  })
})

describe('displayLabel', () => {
  it('formats versioned and named labels', () => {
    expect(displayLabel(version(1, 2, 3))).toBe('1.2.3')
    expect(displayLabel(name('checkout-redesign'))).toBe('checkout-redesign')
  })
})

describe('isReleaseBranch', () => {
  it('returns true for both branch schemes', () => {
    expect(isReleaseBranch('release/v1.2.3')).toBe(true)
    expect(isReleaseBranch('release/n/checkout-redesign')).toBe(true)
    expect(isReleaseBranch('refs/heads/release/v1.2.3')).toBe(true)
  })

  it('returns false for junk', () => {
    expect(isReleaseBranch('feature/x')).toBe(false)
    expect(isReleaseBranch('release/foo')).toBe(false)
    expect(isReleaseBranch('main')).toBe(false)
  })

  it('returns false for null and undefined', () => {
    expect(isReleaseBranch(null)).toBe(false)
    expect(isReleaseBranch(undefined)).toBe(false)
  })
})

describe('compareReleaseIds', () => {
  it('sorts pure-version arrays in numeric semver order (not lexicographic)', () => {
    const ids = [version(1, 10, 0), version(1, 9, 0), version(2, 0, 0), version(1, 9, 5)]
    const sorted = [...ids].sort((a, b) => {
      return compareReleaseIds(a, b)
    })

    expect(sorted).toEqual([version(1, 9, 0), version(1, 9, 5), version(1, 10, 0), version(2, 0, 0)])
  })

  it('matches existing semver order byte-for-byte for the all-versioned case', () => {
    const raws = [version(1, 62, 0), version(1, 64, 5), version(1, 63, 0)]
      .sort((a, b) => {
        return compareReleaseIds(a, b)
      })
      .map((id) => {
        return displayLabel(id)
      })

    expect(raws).toEqual(['1.62.0', '1.63.0', '1.64.5'])
  })

  it('places all names after all versions regardless of comparison order', () => {
    expect(compareReleaseIds(version(9, 9, 9), name('aaa'))).toBeLessThan(0)
    expect(compareReleaseIds(name('aaa'), version(0, 0, 0))).toBeGreaterThan(0)
  })

  it('produces a versions-block-then-names-block when sorted', () => {
    const ids = [name('zeta'), version(2, 0, 0), name('alpha'), version(1, 0, 0)]
    const sorted = [...ids].sort((a, b) => {
      return compareReleaseIds(a, b)
    })

    expect(sorted).toEqual([version(1, 0, 0), version(2, 0, 0), name('alpha'), name('zeta')])
  })

  it('orders names by date ascending when both dates are provided', () => {
    const result = compareReleaseIds(name('zzz'), name('aaa'), {
      a: '2026-01-01T00:00:00Z',
      b: '2026-02-01T00:00:00Z',
    })

    // zzz is earlier by date, so it sorts first despite later lexicographically.
    expect(result).toBeLessThan(0)
  })

  it('accepts Date objects for name dates', () => {
    const result = compareReleaseIds(name('aaa'), name('zzz'), {
      a: new Date('2026-03-01T00:00:00Z'),
      b: new Date('2026-01-01T00:00:00Z'),
    })

    // aaa is later by date, so it sorts after zzz.
    expect(result).toBeGreaterThan(0)
  })

  it('falls back to lexicographic name order when dates are absent', () => {
    expect(compareReleaseIds(name('alpha'), name('beta'))).toBeLessThan(0)
    expect(compareReleaseIds(name('beta'), name('alpha'))).toBeGreaterThan(0)
    expect(compareReleaseIds(name('same'), name('same'))).toBe(0)
  })

  it('falls back to lexicographic order when only one date is present', () => {
    expect(compareReleaseIds(name('alpha'), name('beta'), { a: '2026-05-01T00:00:00Z' })).toBeLessThan(0)
  })

  it('falls back to lexicographic order when dates are equal', () => {
    const date = '2026-01-01T00:00:00Z'

    expect(compareReleaseIds(name('alpha'), name('beta'), { a: date, b: date })).toBeLessThan(0)
  })

  it('ignores invalid date strings and falls back to lexicographic order', () => {
    expect(compareReleaseIds(name('alpha'), name('beta'), { a: 'not-a-date', b: 'also-bad' })).toBeLessThan(0)
  })

  it('is stable and deterministic across repeated sorts', () => {
    const ids = [name('b'), version(1, 0, 0), name('a'), version(0, 5, 0), name('c')]
    const first = [...ids].sort((a, b) => {
      return compareReleaseIds(a, b)
    })
    const second = [...ids].sort((a, b) => {
      return compareReleaseIds(a, b)
    })

    expect(first).toEqual(second)
    expect(first).toEqual([version(0, 5, 0), version(1, 0, 0), name('a'), name('b'), name('c')])
  })
})
