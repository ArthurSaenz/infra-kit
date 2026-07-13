import { describe, expect, it } from 'vitest'

import { OperationError } from 'src/lib/errors/operation-error'

import {
  DEV_REF,
  formatBranchPickerItems,
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

describe('formatBranchPickerItems', () => {
  it('labels versions and names, keying Jira descriptions by the Jira version name', () => {
    const items = formatBranchPickerItems({
      branches: ['release/v1.2.3', 'release/checkout-redesign'],
      // Jira descriptions are keyed by the Jira version NAME: `v1.2.3` | `<name>`.
      descriptions: new Map([
        ['v1.2.3', 'version desc'],
        ['checkout-redesign', 'name desc'],
      ]),
    })

    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      value: 'release/v1.2.3',
      label: '1.2.3',
      description: 'version desc',
      type: undefined,
    })
    expect(items[1]).toEqual({
      value: 'release/checkout-redesign',
      label: 'checkout-redesign',
      description: 'name desc',
      type: undefined,
    })
  })

  it('leaves the description undefined when Jira has none for that branch', () => {
    const items = formatBranchPickerItems({
      branches: ['release/v1.2.3'],
      descriptions: new Map(),
    })

    expect(items[0]?.description).toBeUndefined()
  })

  it('includes the resolved type when a types map is provided', () => {
    const items = formatBranchPickerItems({
      branches: ['release/checkout-redesign'],
      descriptions: new Map(),
      types: new Map([['release/checkout-redesign', 'hotfix']]),
    })

    expect(items[0]?.type).toBe('hotfix')
  })

  it('defaults to "regular" when a types map is provided but the branch is absent from it', () => {
    const items = formatBranchPickerItems({
      branches: ['release/checkout-redesign'],
      descriptions: new Map(),
      types: new Map(),
    })

    expect(items[0]?.type).toBe('regular')
  })

  it('leaves type undefined when no types map is provided', () => {
    const items = formatBranchPickerItems({
      branches: ['release/checkout-redesign'],
      descriptions: new Map(),
    })

    expect(items[0]?.type).toBeUndefined()
  })

  it('drops branches that do not parse as release ids', () => {
    const items = formatBranchPickerItems({
      branches: ['release/v1.2.3', 'feature/not-a-release'],
      descriptions: new Map(),
    })

    expect(
      items.map((i) => {
        return i.value
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
