import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { maxJsdocSummaryLines } from '../max-jsdoc-summary-lines'

// Wire ESLint's RuleTester into vitest's lifecycle so each case becomes a real test.
const ruleTesterHooks = RuleTester as unknown as {
  afterAll: typeof afterAll
  describe: typeof describe
  it: typeof it
  itOnly: typeof it.only
}

ruleTesterHooks.afterAll = afterAll
ruleTesterHooks.describe = describe
ruleTesterHooks.it = it
// eslint-disable-next-line test/no-only-tests -- RuleTester requires an `itOnly` hook reference.
ruleTesterHooks.itOnly = it.only

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
})

const proseLines = (count: number): string[] => {
  return Array.from({ length: count }, (_, index) => {
    return ` * Prose line ${index + 1}.`
  })
}

// A JSDoc block that is nothing but a summary paragraph of `count` prose lines. Delimiters are
// not counted, so this block occupies `count + 2` source lines and reports `count`.
const summaryBlock = (count: number): string => {
  return ['/**', ...proseLines(count), ' */'].join('\n')
}

// A 6-line summary with `@fileoverview` AFTER it rather than opening the block. Deliberate: a
// block that OPENS with `@fileoverview` has a zero-line summary and can never report, so it would
// prove nothing about the exemption. This shape would report at 6 but for the tag, and the paired
// `exemptTags: []` case below shows the exemption is what silences it.
const FILEOVERVIEW_BLOCK = [
  '/**',
  ...proseLines(6),
  ' *',
  ' * @fileoverview Why this module exists, and the constraints it balances.',
  ' */',
  'export const VERSION = 1',
].join('\n')

// A 3-line summary followed by twenty `@param` lines. The tag ends the paragraph with no blank
// line in between, and the twenty tag lines are outside the budget entirely.
const MANY_PARAMS_BLOCK = [
  '/**',
  ' * Folds ledger rows into per-kind totals.',
  ' * Rows without a kind are ignored.',
  ' * The result is sorted by kind.',
  ...Array.from({ length: 20 }, (_, index) => {
    return ` * @param arg${index + 1} - Argument ${index + 1}.`
  }),
  ' */',
  'export const summarize = () => {}',
].join('\n')

// 2 summary lines, a blank line, then a 10-line detail paragraph. Only the first paragraph is
// capped — this is the shape the rule is asking authors to write.
const SUMMARY_PLUS_DETAIL = [
  '/**',
  ' * Folds ledger rows into per-kind totals.',
  ' * Rows without a kind are ignored.',
  ' *',
  ...proseLines(10),
  ' */',
  'export const summarize = () => {}',
].join('\n')

// Neither of these is a JSDoc block: a `//` line comment, and a `/*` block whose text starts with
// a newline rather than `*`. `isJsdocBlock` is the whole filter, so both are invisible.
const NON_JSDOC_COMMENTS = [
  '// A single-line note that is far longer than any five-line paragraph would ever be, and is never measured.',
  '/*',
  ' * Plain block line 1.',
  ' * Plain block line 2.',
  ' * Plain block line 3.',
  ' * Plain block line 4.',
  ' * Plain block line 5.',
  ' * Plain block line 6.',
  ' */',
  'export const fn = () => {}',
].join('\n')

ruleTester.run('max-jsdoc-summary-lines', maxJsdocSummaryLines, {
  valid: [
    // #1 — exactly at the default cap. The report is `>`, not `>=`.
    { code: `${summaryBlock(5)}\nexport const fn = () => {}` },
    // #2 — a 6-line summary exempted by `@fileoverview`; #8 is the same fixture with the option
    // emptied, so the pair pins the exemption rather than assuming it.
    { code: FILEOVERVIEW_BLOCK },
    // #3 — 3-line summary, twenty `@param` lines. A tag ends the paragraph; tag lines are never
    // charged to it. This is what makes the rule compose with `max-jsdoc-lines` instead of
    // duplicating it: the block is 24 lines tall and perfectly well shaped.
    { code: MANY_PARAMS_BLOCK },
    // #4 — 2-line summary, blank line, 10-line detail paragraph. The blank line is the boundary;
    // everything below it is out of budget however long it runs.
    { code: SUMMARY_PLUS_DETAIL },
    // #5 — a `//` comment and a plain 8-line `/* */` block: neither is JSDoc, neither is measured.
    { code: NON_JSDOC_COMMENTS },
  ],
  invalid: [
    // #6 — one line over the default cap.
    {
      code: `${summaryBlock(6)}\nexport const fn = () => {}`,
      errors: [{ messageId: 'summaryTooLong', data: { lines: 6, max: 5 } }],
    },
    // #7 — no blank line and no tags anywhere: the whole block is one paragraph, so all 7 of its
    // prose lines are the summary. The block occupies 9 source lines; the opener and closer carry
    // no prose and are not charged.
    {
      code: `${summaryBlock(7)}\nexport const fn = () => {}`,
      errors: [{ messageId: 'summaryTooLong', data: { lines: 7, max: 5 } }],
    },
    // #8 — `exemptTags: []` un-exempts #2's `@fileoverview` block: the escape hatch is live, and
    // the tag is the only reason #2 passes.
    {
      code: FILEOVERVIEW_BLOCK,
      options: [{ exemptTags: [] }],
      errors: [{ messageId: 'summaryTooLong', data: { lines: 6, max: 5 } }],
    },
    // #9 — the default spelled out explicitly reports identically to #6.
    {
      code: `${summaryBlock(6)}\nexport const fn = () => {}`,
      options: [{ maxSummaryLines: 5 }],
      errors: [{ messageId: 'summaryTooLong', data: { lines: 6, max: 5 } }],
    },
    // #10 — a tighter cap is honoured: 4 summary lines pass at the default and report at 3.
    {
      code: dedent`
        /**
         * Folds ledger rows into per-kind totals.
         * Rows without a kind are ignored.
         * The result is sorted by kind.
         * Empty input yields an empty result.
         */
        export const summarize = () => {}
      `,
      options: [{ maxSummaryLines: 3 }],
      errors: [{ messageId: 'summaryTooLong', data: { lines: 4, max: 3 } }],
    },
  ],
})
