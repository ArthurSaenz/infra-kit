import { beforeAll, describe, expect, it } from 'vitest'

import config from '../index.js'
import { makeLintIndex } from './_lint-fixtures.js'

// Phase 2 policy: cross-element imports between siblings (feature<->feature, service<->service)
// must be TYPE-ONLY — no runtime/value cross-import. The shared layer is the one runtime
// exception (features/services may import it through its barrel); shared may not depend outward.
// This drives the real exported config over a fixture tree and asserts that matrix. The
// lint-and-index harness lives in ./_lint-fixtures.ts, shared with no-restricted-imports.test.ts.
const { populate, messagesFor, expectFlagged } = makeLintIndex({
  fixtures: '__tests__/fixtures-p2/src',
  ruleFilter: (id) => (id ?? '').startsWith('boundaries/'),
  flagRuleId: 'boundaries/dependencies',
})

beforeAll(populate)

describe('boundaries: sibling cross-imports are type-only', () => {
  it('flags a runtime cross-feature import through the barrel', () => {
    expectFlagged('features/beta/uses-alpha-barrel.ts', 'no rule allowing')
  })

  it('flags a runtime cross-feature import into internals', () => {
    expectFlagged('features/beta/uses-alpha-internal.ts', 'no rule allowing')
  })

  it('flags a runtime cross-service import through the barrel', () => {
    expectFlagged('services/sms/uses-email-barrel.ts', 'no rule allowing')
  })

  it('allows a type-only cross-feature import', () => {
    expect(messagesFor('features/beta/uses-alpha-internal-type.ts')).toHaveLength(0)
  })

  it('allows a type-only cross-service import', () => {
    expect(messagesFor('services/sms/uses-email-type.ts')).toHaveLength(0)
  })

  it('allows a same-feature relative import into own internals', () => {
    expect(messagesFor('features/beta/uses-self-internal.ts')).toHaveLength(0)
  })
})

describe('boundaries: shared layer', () => {
  it('allows a feature to import shared at runtime through its barrel', () => {
    expect(messagesFor('features/beta/uses-shared.ts')).toHaveLength(0)
  })

  it('flags a runtime deep import into shared (barrel only)', () => {
    expectFlagged('features/beta/uses-shared-deep.ts', 'no rule allowing')
  })

  it('flags the shared layer depending outward on a feature', () => {
    expectFlagged('shared/uses-feature.ts', 'no rule allowing')
  })
})

describe('boundaries: config integrity', () => {
  it('registers the boundaries plugin and the dependencies rule', async () => {
    const flat = await config()
    const withBoundaries = flat.find((c) => {
      return c?.plugins?.boundaries
    })

    expect(withBoundaries).toBeDefined()
    expect(withBoundaries?.rules?.['boundaries/dependencies']?.[0]).toBe('warn')
  })
})
