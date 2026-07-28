import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

import wl from '../../../index'
import { dedent } from '../../../test-utils/dedent'

// THE ANTI-DEADLOCK CONTRACT (PM-2), in executable form. `@wl/require-jsdoc-example` MANDATES an
// `@example` at cognitive complexity >= 12; `@wl/max-jsdoc-lines` charges that example to
// `maxExampleLines` and NEVER to `maxLines`. So the functions one rule forces to carry a worked
// example can always satisfy the other's prose budget. If the two budgets are ever merged into one,
// this suite goes red — which is the whole point of it existing.
//
// Both rules run in ONE lint pass over a `.ts` (not `.tsx`) file at a normal `src/` path, because
// that is where the affected population actually lives: named functions in plain lib/util modules.

const MAX_JSDOC_LINES = '@wl/max-jsdoc-lines'
const REQUIRE_JSDOC_EXAMPLE = '@wl/require-jsdoc-example'

const FILENAME = 'src/lib/ledger/summarize.ts'

// Cognitive complexity 15 (>= the `exampleComplexity` default of 12), so BOTH the JSDoc block and
// the `@example` inside it are mandatory here: for(1) + if(2) + for(2) + if(3) + if/else-if/else(4)
// + if(2) + the `&&` run(1).
const COMPLEX_FUNCTION = dedent`
  export const summarize = (rows: LedgerRow[], options: SummarizeOptions) => {
    const totals = { credit: 0, debit: 0, other: 0 }

    for (const row of rows) {
      if (!row) {
        continue
      }

      for (const tag of row.tags) {
        if (tag === 'void') {
          return null
        }
      }

      if (row.kind === 'debit') {
        totals.debit += row.amount
      } else if (row.kind === 'credit') {
        totals.credit += row.amount
      } else {
        totals.other += row.amount
      }

      if (options.strict && row.amount < 0) {
        throw new Error('negative amount')
      }
    }

    return totals
  }
`

// 13 lines: 6 of prose and a 7-line `@example` body (the tag line through the closing line). Sized
// deliberately OFF the `maxExampleLines` boundary of 10 in both directions, so the test asserts the
// contract rather than the edge case — an example that only passes AT the limit proves nothing
// about whether a real author has room to work.
const WORKED_EXAMPLE_BLOCK = dedent`
  /**
   * Fold ledger rows into per-kind totals.
   *
   * @param rows - Ledger rows to fold; falsy entries are skipped.
   * @param options - \`strict\` rejects negative amounts.
   *
   * @example
   * const totals = summarize(rows, { strict: true })
   * // → { credit: 40, debit: 120, other: 0 }
   * const net = totals.credit - totals.debit
   * console.log(net)
   * // → -80
   */
`

// A well-formed block that is comfortably inside the prose budget but carries NO `@example`. Used
// to pin `COMPLEX_FUNCTION` above `exampleComplexity` (12): only a function at or above that
// threshold turns a missing `@example` into a report.
const NO_EXAMPLE_BLOCK = dedent`
  /**
   * Fold ledger rows into per-kind totals.
   *
   * @param rows - Ledger rows to fold; falsy entries are skipped.
   * @param options - \`strict\` rejects negative amounts.
   */
`

// The same block with the example padded past the budget — the control that proves the example
// budget is actually live in this composed config (a "zero reports" assertion is only meaningful
// next to one that reports).
const OVERSIZED_EXAMPLE_BLOCK = dedent`
  /**
   * Fold ledger rows into per-kind totals.
   *
   * @example
   * const totals = summarize(rows, { strict: true })
   * const net = totals.credit - totals.debit
   * const gross = totals.credit + totals.debit
   * const ratio = totals.credit / totals.debit
   * const label = 'net: ' + net
   * const rounded = Math.round(ratio)
   * const flagged = rounded > 1
   * const summary = [label, gross, flagged]
   * console.log(summary)
   * const done = true
   */
`

// Both rules forced live at 'error'. They are never enabled together by the shipped configs —
// `require-jsdoc-example` rides the components preset and `max-jsdoc-lines` the `o.jsdoc` gate in
// the config layer — so this config is what the composed end state looks like.
const config: Linter.Config[] = [
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { '@wl': wl },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      [MAX_JSDOC_LINES]: 'error',
      [REQUIRE_JSDOC_EXAMPLE]: 'error',
    },
  },
]

const linter = new Linter({ configType: 'flat' })

const wlMessages = (code: string): Linter.LintMessage[] => {
  return linter.verify(code, config, { filename: FILENAME }).filter((message) => {
    return message.ruleId === MAX_JSDOC_LINES || message.ruleId === REQUIRE_JSDOC_EXAMPLE
  })
}

describe('max-jsdoc-lines + require-jsdoc-example (PM-2 anti-deadlock gate)', () => {
  it('reports nothing when a mandated example is worked but concise', () => {
    expect(wlMessages(`${WORKED_EXAMPLE_BLOCK}\n${COMPLEX_FUNCTION}`)).toEqual([])
  })

  it('still requires the example (control: the mandating rule is live)', () => {
    const messages = wlMessages(COMPLEX_FUNCTION)

    expect(messages).toHaveLength(1)
    expect(messages[0]?.ruleId).toBe(REQUIRE_JSDOC_EXAMPLE)
    expect(messages[0]?.messageId).toBe('missingJsdoc')
  })

  // Pins the fixture's complexity at >= 12, which the `missingJsdoc` control above cannot do:
  // that message fires from `minComplexity` (8), so a later edit that simplified `COMPLEX_FUNCTION`
  // to complexity 9 would keep every other test green while quietly making the anti-deadlock
  // assertion vacuous — no example would be mandated, so there would be no deadlock to avoid.
  // `missingExample` fires ONLY at `exampleComplexity` (12), so it fails loudly instead.
  it('pins the fixture above exampleComplexity (a block without an @example is rejected)', () => {
    const messages = wlMessages(`${NO_EXAMPLE_BLOCK}\n${COMPLEX_FUNCTION}`)

    expect(messages).toHaveLength(1)
    expect(messages[0]?.ruleId).toBe(REQUIRE_JSDOC_EXAMPLE)
    expect(messages[0]?.messageId).toBe('missingExample')
  })

  it('still caps the example (control: the capping rule is live)', () => {
    const messages = wlMessages(`${OVERSIZED_EXAMPLE_BLOCK}\n${COMPLEX_FUNCTION}`)

    expect(messages).toHaveLength(1)
    expect(messages[0]?.ruleId).toBe(MAX_JSDOC_LINES)
    expect(messages[0]?.messageId).toBe('exampleTooLong')
  })
})
