import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import { OperationError } from 'src/lib/errors/operation-error'
import type { ReleaseType } from 'src/lib/release-utils'
import type { ReleaseEntry } from 'src/lib/version-utils'

import { assertHomogeneousReleaseType, releaseCreateMcpTool } from '../release-create'

/**
 * The MCP `releases[]` entry schema enforces that exactly one of `version` or
 * `name` is supplied, and transforms each entry into the internal ReleaseInput
 * shape. We exercise the schema directly (the array element) so we do not need
 * to run the full handler (which performs git/Jira side effects).
 */
const entrySchema = (releaseCreateMcpTool.inputSchema.releases as z.ZodArray<z.ZodTypeAny>).element

describe('release-create MCP releases[] entry schema', () => {
  it('accepts a versioned entry and transforms it into a version ReleaseInput', () => {
    expect(entrySchema.parse({ version: '1.2.5', type: 'hotfix' })).toEqual({
      version: '1.2.5',
      type: 'hotfix',
    })
  })

  it('defaults type to regular', () => {
    expect(entrySchema.parse({ version: '1.2.5' })).toEqual({
      version: '1.2.5',
      type: 'regular',
    })
  })

  it('accepts a named entry and transforms it into a name ReleaseInput', () => {
    expect(entrySchema.parse({ name: 'checkout-redesign', type: 'regular' })).toEqual({
      name: 'checkout-redesign',
      type: 'regular',
    })
  })

  it('carries description through for named entries', () => {
    expect(entrySchema.parse({ name: 'checkout-redesign', description: 'Q3' })).toEqual({
      name: 'checkout-redesign',
      type: 'regular',
      description: 'Q3',
    })
  })

  it('rejects an entry with both version and name (mutually exclusive)', () => {
    expect(() => {
      return entrySchema.parse({ version: '1.2.5', name: 'checkout-redesign' })
    }).toThrow(/exactly one of/)
  })

  it('rejects an entry with neither version nor name', () => {
    expect(() => {
      return entrySchema.parse({ type: 'regular' })
    }).toThrow(/exactly one of/)
  })
})

const entryOfType = (type: ReleaseType): ReleaseEntry => {
  return {
    id: { kind: 'version', semver: { major: 1, minor: 2, patch: 3 }, raw: '1.2.3' },
    type,
  } as ReleaseEntry
}

describe('assertHomogeneousReleaseType', () => {
  it('accepts an all-regular batch', () => {
    expect(() => {
      return assertHomogeneousReleaseType([entryOfType('regular'), entryOfType('regular')])
    }).not.toThrow()
  })

  it('accepts an all-hotfix batch', () => {
    expect(() => {
      return assertHomogeneousReleaseType([entryOfType('hotfix')])
    }).not.toThrow()
  })

  it('rejects a mixed regular+hotfix batch with an OperationError', () => {
    expect(() => {
      return assertHomogeneousReleaseType([entryOfType('regular'), entryOfType('hotfix')])
    }).toThrow(OperationError)
  })

  it('mixed-batch error mentions separate invocations', () => {
    expect(() => {
      return assertHomogeneousReleaseType([entryOfType('regular'), entryOfType('hotfix')])
    }).toThrow(/separate invocations/)
  })
})
