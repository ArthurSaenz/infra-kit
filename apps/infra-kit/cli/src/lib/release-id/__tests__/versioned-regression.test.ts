import { describe, expect, it } from 'vitest'

import {
  compareReleaseIds,
  displayLabel,
  formatBranchName,
  formatJiraName,
  formatPrTitle,
  formatRcTitle,
  parseBranchName,
  parseReleaseRef,
} from 'src/lib/release-id'
import { sortVersions } from 'src/lib/version-utils'

/**
 * Regression lock for the named-releases feature (plan Principle 2):
 * a VERSIONED release must produce byte-identical branch names, PR titles,
 * RC titles, Jira version names, display labels, and sort order to the
 * pre-named-releases behavior. If any assertion here fails, versioned
 * releases have regressed.
 */
describe('versioned-release output regression', () => {
  const id = parseReleaseRef('1.62.0')

  it('derives byte-identical strings for a versioned release', () => {
    expect(formatBranchName(id)).toBe('release/v1.62.0')
    expect(formatPrTitle(id, 'regular')).toBe('Release v1.62.0')
    expect(formatPrTitle(id, 'hotfix')).toBe('Hotfix v1.62.0')
    expect(formatRcTitle(id)).toBe('Release v1.62.0 (RC)')
    expect(formatJiraName(id)).toBe('v1.62.0')
    expect(displayLabel(id)).toBe('1.62.0')
  })

  it('accepts the historical input forms for the same version', () => {
    for (const input of ['1.62.0', 'v1.62.0', 'release/v1.62.0']) {
      expect(formatBranchName(parseReleaseRef(input))).toBe('release/v1.62.0')
    }

    expect(parseBranchName('release/v1.62.0')).toEqual(id)
  })

  it('sorts pure-version branch lists in the same order as legacy sortVersions', () => {
    const branches = ['release/v1.10.0', 'release/v1.9.3', 'release/v2.0.0', 'release/v1.9.10', 'release/v1.62.0']

    const expectedOrder = ['release/v1.9.3', 'release/v1.9.10', 'release/v1.10.0', 'release/v1.62.0', 'release/v2.0.0']

    const newOrder = [...branches].sort((a, b) => {
      const idA = parseBranchName(a)
      const idB = parseBranchName(b)

      if (idA === null || idB === null) throw new Error('unexpected unparseable version branch')

      return compareReleaseIds(idA, idB)
    })

    expect(newOrder).toEqual(expectedOrder)

    // Cross-check against legacy sortVersions on its v-token contract.
    const asToken = (branch: string): string => {
      const id = parseBranchName(branch)

      if (id === null) throw new Error('unexpected unparseable version branch')

      return `v${displayLabel(id)}`
    }

    expect(newOrder.map(asToken)).toEqual(sortVersions(branches.map(asToken)))
  })
})
