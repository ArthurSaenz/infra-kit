import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import { releaseCreateMcpTool } from '../release-create'

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
