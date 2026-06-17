import { describe, expect, it } from 'vitest'

import { OperationError } from 'src/lib/errors/operation-error'

import {
  DEV_REF,
  formatBranchChoices,
  parseBranchChoices,
  releaseLabelFromBranch,
  resolveReleaseBranch,
} from '../release-utils'

describe('parseBranchChoices', () => {
  it('parses version and name branches and drops junk', () => {
    const result = parseBranchChoices([
      'release/v1.2.3',
      'release/checkout-redesign',
      'feature/not-a-release',
      'release/v9.9', // malformed semver
    ])

    const labels = result.map((r) => {
      return r.label
    })
    const kinds = result.map((r) => {
      return r.id.kind
    })
    const branches = result.map((r) => {
      return r.branch
    })

    expect(labels).toEqual(['1.2.3', 'checkout-redesign'])
    expect(kinds).toEqual(['version', 'name'])
    expect(branches).toEqual(['release/v1.2.3', 'release/checkout-redesign'])
  })

  it('returns an empty array when nothing parses', () => {
    expect(parseBranchChoices(['main', 'dev', 'feature/x'])).toEqual([])
  })
})

describe('formatBranchChoices', () => {
  it('labels versions and names, keying Jira descriptions by the Jira version name', () => {
    const choices = formatBranchChoices({
      branches: ['release/v1.2.3', 'release/checkout-redesign'],
      // Jira descriptions are keyed by the Jira version NAME: `v1.2.3` | `<name>`.
      descriptions: new Map([
        ['v1.2.3', 'version desc'],
        ['checkout-redesign', 'name desc'],
      ]),
    })

    expect(choices).toHaveLength(2)
    expect(choices[0]?.value).toBe('release/v1.2.3')
    expect(choices[0]?.name).toContain('1.2.3')
    expect(choices[0]?.name).toContain('version desc')
    expect(choices[1]?.value).toBe('release/checkout-redesign')
    expect(choices[1]?.name).toContain('checkout-redesign')
    expect(choices[1]?.name).toContain('name desc')
  })

  it('includes the type tag when types are provided', () => {
    const choices = formatBranchChoices({
      branches: ['release/checkout-redesign'],
      descriptions: new Map(),
      types: new Map([['release/checkout-redesign', 'hotfix']]),
    })

    expect(choices[0]?.name).toContain('[hotfix]')
  })

  it('drops branches that do not parse as release ids', () => {
    const choices = formatBranchChoices({
      branches: ['release/v1.2.3', 'feature/not-a-release'],
      descriptions: new Map(),
    })

    expect(
      choices.map((c) => {
        return c.value
      }),
    ).toEqual(['release/v1.2.3'])
  })
})

describe('resolveReleaseBranch', () => {
  it('builds a version branch from a bare or v-prefixed version', () => {
    expect(resolveReleaseBranch('1.2.3')).toBe('release/v1.2.3')
    expect(resolveReleaseBranch('v1.2.3')).toBe('release/v1.2.3')
  })

  it('builds a name branch from a release name', () => {
    expect(resolveReleaseBranch('checkout-redesign')).toBe('release/checkout-redesign')
  })

  it('throws an OperationError for junk input', () => {
    expect(() => {
      return resolveReleaseBranch('Not A Valid Name')
    }).toThrow(OperationError)
  })

  it('throws an OperationError for the unresolved "next" token', () => {
    expect(() => {
      return resolveReleaseBranch('next')
    }).toThrow(OperationError)
  })
})

describe('releaseLabelFromBranch', () => {
  it('passes through the dev sentinel unchanged', () => {
    expect(releaseLabelFromBranch(DEV_REF)).toBe('dev')
  })

  it('labels version and name branches', () => {
    expect(releaseLabelFromBranch('release/v1.2.3')).toBe('1.2.3')
    expect(releaseLabelFromBranch('release/checkout-redesign')).toBe('checkout-redesign')
  })

  it('falls back to the raw branch when it does not parse', () => {
    expect(releaseLabelFromBranch('feature/not-a-release')).toBe('feature/not-a-release')
  })
})
