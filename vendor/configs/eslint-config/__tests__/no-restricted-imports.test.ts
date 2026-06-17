import { beforeAll, describe, expect, it } from 'vitest'

import config from '../index.js'
import { makeLintIndex } from './_lint-fixtures.js'

// Fixture tree exercising the path-based `no-restricted-imports` rule (Phase 1): a deep import
// into a feature/service is flagged; its barrel and relative intra-element imports pass. The
// lint-and-index harness lives in ./_lint-fixtures.ts, shared with boundaries.test.ts so the
// two suites cannot drift apart.
const { populate, messagesFor, expectFlagged } = makeLintIndex({
  fixtures: '__tests__/fixtures/src',
  ruleFilter: (id) => id === 'no-restricted-imports',
  flagRuleId: 'no-restricted-imports',
})

beforeAll(populate)

describe('no-restricted-imports: feature public-API boundary', () => {
  it('flags a deep feature import at depth 1 (#root/features/alpha/util)', () => {
    expectFlagged('features/beta/bad-deep-1.ts', "feature's public API")
  })

  it('flags a deep feature import at depth 2 (#root/features/alpha/components/Widget)', () => {
    // The previous `*/features/*/*` glob missed depth >= 2 — this guards the regression.
    expectFlagged('features/beta/bad-deep-2.ts', "feature's public API")
  })

  it('allows importing a feature through its barrel (#root/features/alpha)', () => {
    expect(messagesFor('features/beta/ok-barrel.ts')).toHaveLength(0)
  })

  it('allows a relative intra-feature import (./local)', () => {
    expect(messagesFor('features/beta/relative-ok.ts')).toHaveLength(0)
  })
})

describe('no-restricted-imports: service public-API boundary', () => {
  it('flags a deep service import (#root/services/email/client)', () => {
    expectFlagged('services/sms/bad-deep.ts', "service's public API")
  })

  it('allows importing a service through its barrel (#root/services/email)', () => {
    expect(messagesFor('services/sms/ok-barrel.ts')).toHaveLength(0)
  })
})

describe('config integrity', () => {
  it('resolves to a non-empty flat config array', async () => {
    const flat = await config()

    expect(Array.isArray(flat)).toBe(true)
    expect(flat.length).toBeGreaterThan(0)
  })
})
