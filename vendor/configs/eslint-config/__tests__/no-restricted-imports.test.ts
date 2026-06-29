import { describe, expect, it } from 'vitest'

import config from '../src/index.js'
import { code, expectClean, expectFlagged, lintCase } from './_lint-case.js'

// Phase 1: the path-based `no-restricted-imports` rule. Deep imports into a feature/service are
// flagged; the barrel (bare or explicit `index[.js]`) and relative intra-element imports pass. The
// rule is STRING-ONLY — it globs the import specifier and never resolves it — so each case is just
// an inline import under a virtual `fileName`. Specifiers mirror the former fixtures exactly.
//
// NOTE: this suite drives the rule through the exported `config()` via lintText rather than ESLint's
// RuleTester. RuleTester would need the CORE rule object, and the only ways to obtain it
// (`eslint/use-at-your-own-risk`'s `builtinRules`, `Linter#getRules()`) are both `@deprecated`.
// lintText needs no rule-object reference — ESLint resolves the rule from the real config — so it
// avoids the deprecated API while still testing our wired patterns end-to-end.
const RULE = 'no-restricted-imports'

// One inline module that imports `spec`. The `fileName` only needs to be a `src/...` file the config
// block applies to (the rule keys off the specifier string, not the importer's location).
const importing = (spec: string) => code`
  import { x } from '${spec}'

  export const a = x
`

describe('no-restricted-imports: feature public-API boundary', () => {
  // POSITIVE CONTROL — proves the rule actually fires on a known-bad inline snippet.
  it('flags a deep feature import at depth 1 (#root/features/alpha/util)', async () => {
    expectFlagged(
      await lintCase({ source: importing('#root/features/alpha/util'), fileName: 'src/features/beta/x.ts' }),
      RULE,
      "feature's public API",
    )
  })

  // The previous `*/features/*/*` glob missed depth >= 2 — this guards the regression.
  it('flags a deep feature import at depth 2 (#root/features/alpha/components/Widget)', async () => {
    expectFlagged(
      await lintCase({
        source: importing('#root/features/alpha/components/Widget'),
        fileName: 'src/features/beta/x.ts',
      }),
      RULE,
      "feature's public API",
    )
  })

  it('allows importing a feature through its barrel (#root/features/alpha)', async () => {
    expectClean(await lintCase({ source: importing('#root/features/alpha'), fileName: 'src/features/beta/x.ts' }), RULE)
  })

  it('allows a relative intra-feature import (./local)', async () => {
    expectClean(await lintCase({ source: importing('./local'), fileName: 'src/features/beta/x.ts' }), RULE)
  })

  // The explicit barrel (#root/features/alpha/index[.js]) IS the public API — and the only valid form
  // under NodeNext/ESM. The `!**/features/*/index*` carve-outs allow it.
  it('allows the explicit feature barrel with extension (#root/features/alpha/index.js)', async () => {
    expectClean(
      await lintCase({ source: importing('#root/features/alpha/index.js'), fileName: 'src/features/beta/x.ts' }),
      RULE,
    )
  })

  it('allows the explicit feature barrel without extension (#root/features/alpha/index)', async () => {
    expectClean(
      await lintCase({ source: importing('#root/features/alpha/index'), fileName: 'src/features/beta/x.ts' }),
      RULE,
    )
  })
})

describe('no-restricted-imports: service public-API boundary', () => {
  it('flags a deep service import (#root/services/email/client)', async () => {
    expectFlagged(
      await lintCase({ source: importing('#root/services/email/client'), fileName: 'src/services/sms/x.ts' }),
      RULE,
      "service's public API",
    )
  })

  it('allows importing a service through its barrel (#root/services/email)', async () => {
    expectClean(await lintCase({ source: importing('#root/services/email'), fileName: 'src/services/sms/x.ts' }), RULE)
  })

  it('allows the explicit service barrel with extension (#root/services/email/index.js)', async () => {
    expectClean(
      await lintCase({ source: importing('#root/services/email/index.js'), fileName: 'src/services/sms/x.ts' }),
      RULE,
    )
  })

  // Pins the exact reported false-positive shape: a RELATIVE explicit-index specifier whose string
  // still contains the `services/<name>/index.js` segment.
  it('allows a relative explicit service barrel (../../services/email/index.js)', async () => {
    expectClean(
      await lintCase({ source: importing('../../services/email/index.js'), fileName: 'src/services/sms/x.ts' }),
      RULE,
    )
  })

  // Regression: only the IMMEDIATE barrel is exempt — a nested `internal/index.js` stays flagged.
  it('flags a deep service import that ends in a nested index (#root/services/email/internal/index.js)', async () => {
    expectFlagged(
      await lintCase({
        source: importing('#root/services/email/internal/index.js'),
        fileName: 'src/services/sms/x.ts',
      }),
      RULE,
      "service's public API",
    )
  })
})

// Self-falsifying guard: a mistyped/ignored virtual path must THROW (not silently report clean).
// This goes RED if either lintCase silent-false-pass guard is removed.
it('meta: an ignored/typo virtual path throws, not silently clean', async () => {
  await expect(lintCase({ source: 'export const x = 1', fileName: '.omc/ignored.ts' })).rejects.toThrow()
})

describe('no-restricted-imports: config integrity', () => {
  it('resolves to a non-empty flat config array', async () => {
    const flat = await config()

    expect(Array.isArray(flat)).toBe(true)
    expect(flat.length).toBeGreaterThan(0)
  })
})
