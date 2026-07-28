import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { maxJsdocLines } from '../max-jsdoc-lines'

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

const fillerLines = (count: number): string[] => {
  return Array.from({ length: count }, (_, index) => {
    return ` * Prose line ${index + 1}.`
  })
}

// A JSDoc block of exactly `lines` source lines, all prose and no tags.
const proseBlock = (lines: number): string => {
  return ['/**', ...fillerLines(lines - 2), ' */'].join('\n')
}

// The same, opening with `@fileoverview` — the module-level escape hatch.
const fileoverviewBlock = (lines: number): string => {
  return ['/**', ' * @fileoverview Why this module exists, at length.', ...fillerLines(lines - 3), ' */'].join('\n')
}

// Models `web-toolkit/src/extracted-atom-type/extracted-atom-type.ts:28`, the corpus's worst
// offender: 43 lines total = 8 prose + a 35-line `@example` body. Its prose sits comfortably
// inside the cap, so ONLY the example budget can reach it — a single combined budget would
// blame the wrong half of the block.
const WORST_OFFENDER = [
  '/**',
  ' * Extracts the first argument type from a WritableAtom write function.',
  ' * Useful for typing action payloads or update parameters.',
  ' *',
  ' * Returns `never` if the type is not a WritableAtom.',
  ' *',
  ' * @template T - The WritableAtom type to extract the action argument from',
  ' *',
  ' * @example',
  ...Array.from({ length: 33 }, (_, index) => {
    return ` * const step${index + 1} = run(${index + 1})`
  }),
  ' */',
  'export type ExtractedArgs<T> = T extends Wrapper<infer Args> ? Args : never',
].join('\n')

// Two `@example` bodies of 6 lines each (tag line through the line before the next tag; the
// second runs through the closing line). They SUM to 12 against one shared example budget.
const TWO_EXAMPLES = [
  '/**',
  ' * Short contract.',
  ' *',
  ' * @example',
  ' * first(1)',
  ' * first(2)',
  ' * first(3)',
  ' * first(4)',
  ' * first(5)',
  ' * @example',
  ' * second(1)',
  ' * second(2)',
  ' * second(3)',
  ' * second(4)',
  ' */',
  'export const first = () => {}',
].join('\n')

// 16 lines of prose opening with `@module` — exempt by default, reported with `exemptTags: []`.
const MODULE_BLOCK = ['/**', ' * @module fixtures', ...fillerLines(13), ' */'].join('\n')

// A 25-line block above an `if` INSIDE a function body. Documented breadth, not a bug: the rule
// is comment-driven, so indented blocks are linted too (7 exceed the cap corpus-wide).
const IN_FUNCTION_BLOCK = [
  'export const run = (flag: boolean) => {',
  proseBlock(25),
  '  if (flag) {',
  '    return 1',
  '  }',
  '',
  '  return 0',
  '}',
].join('\n')

ruleTester.run('max-jsdoc-lines', maxJsdocLines, {
  valid: [
    // #1 — a 4-line block (corpus p50 is 4): the shape the rule must never touch.
    {
      code: dedent`
        /**
         * Folds ledger rows into per-kind totals.
         * Rows without a kind are ignored.
         */
        export const summarize = () => {}
      `,
    },
    // #2 — exactly at the default prose cap. The report is \`>\`, not \`>=\`.
    { code: `${proseBlock(15)}\nexport const fn = () => {}` },
    // #3 — an `@example` body of exactly 10 lines (tag line + 8 body lines + the closing
    // line): on the boundary, so allowed. Prose is 3.
    {
      code: dedent`
        /**
         * Short contract.
         *
         * @example
         * const totals = summarize(rows)
         * const net = totals.credit - totals.debit
         * const label = 'net: ' + net
         * console.log(label)
         * const first = totals.rows[0]
         * const last = totals.rows[1]
         * const both = [first, last]
         * console.log(both)
         */
        export const summarize = () => {}
      `,
    },
    // #4 — PM-1's case: a 60-line module-level block tagged `@fileoverview` on an
    // `export const`. The tag is the ONLY thing exempting it; position is irrelevant.
    { code: `${fileoverviewBlock(60)}\nexport const VERSION = 1` },
    // #5 — THE INDEPENDENCE PROOF: 6 lines of prose + a 9-line `@example`. Both budgets are
    // satisfied separately; one combined budget of 15 would sit exactly on the edge and a
    // single extra example line would blame the prose.
    {
      code: dedent`
        /**
         * Folds ledger rows into per-kind totals.
         * Rows without a kind are ignored.
         *
         * @param rows - Ledger rows to fold.
         *
         * @example
         * const totals = summarize(rows)
         * const net = totals.credit - totals.debit
         * const label = 'net: ' + net
         * console.log(label)
         * const ok = net > 0
         * console.log(ok)
         * const done = true
         */
        export const summarize = (rows: unknown[]) => rows
      `,
    },
    // #6 — EOF guard: a 20-line block with no token after it is degenerate input, not a
    // documented symbol. Over the cap, and still silent.
    { code: ['export const fn = () => {}', '', proseBlock(20)].join('\n') },
    // #7 — `@module` is exempt under the DEFAULT `exemptTags`; #13 is the same fixture with
    // the option emptied, so the pair pins the default list itself.
    { code: `${MODULE_BLOCK}\nexport const fn = () => {}` },
    // #8 — a line comment of any length is not a JSDoc block and is never measured.
    {
      code: ['// '.concat('a very long single-line note. '.repeat(4)), 'export const fn = () => {}'].join('\n'),
    },
  ],
  invalid: [
    // #9 — one line over the default prose cap on a plain `export const`.
    {
      code: `${proseBlock(16)}\nexport const fn = () => {}`,
      errors: [{ messageId: 'tooManyLines', data: { lines: 16, max: 15 } }],
    },
    // #10 — an 11-line `@example` with 3 lines of prose: `exampleTooLong` ONLY. This is the
    // §5 probe that every one of the 75 off-the-shelf `jsdoc/*` rules passes clean.
    {
      code: dedent`
        /**
         * Short contract.
         *
         * @example
         * const totals = summarize(rows)
         * const net = totals.credit - totals.debit
         * const label = 'net: ' + net
         * console.log(label)
         * const first = totals.rows[0]
         * const last = totals.rows[1]
         * const both = [first, last]
         * console.log(both)
         * console.log(net)
         */
        export const summarize = () => {}
      `,
      errors: [{ messageId: 'exampleTooLong', data: { lines: 11, max: 10 } }],
    },
    // #11 — the real worst offender's shape (8 prose / 35 example) on a `type` alias:
    // `exampleTooLong` only, and explicitly NO `tooManyLines`. A combined budget would
    // report the wrong thing here, and node-driven rules would not see a `type` at all.
    {
      code: WORST_OFFENDER,
      errors: [{ messageId: 'exampleTooLong', data: { lines: 35, max: 10 } }],
    },
    // #12 — two 6-line `@example` bodies sum to 12 against the one example budget.
    {
      code: TWO_EXAMPLES,
      errors: [{ messageId: 'exampleTooLong', data: { lines: 12, max: 10 } }],
    },
    // #13 — `exemptTags: []` un-exempts the `@module` block from #7: the option is live.
    {
      code: `${MODULE_BLOCK}\nexport const fn = () => {}`,
      options: [{ exemptTags: [] }],
      errors: [{ messageId: 'tooManyLines', data: { lines: 16, max: 15 } }],
    },
    // #14 — POSITIONAL-EXEMPTION REGRESSION: a 60-line untagged block sitting above the first
    // `import` is REPORTED. v1's "precedes the first import" exemption would have silenced
    // this; it was deleted because it exempts by luck. Tagging is the fix, not position.
    {
      code: `${proseBlock(60)}\nimport { thing } from './thing'\n\nexport const fn = () => thing`,
      errors: [{ messageId: 'tooManyLines', data: { lines: 60, max: 15 } }],
    },
    // #15 — an in-function block is linted like any other. Documented breadth: no dedicated
    // escape hatch is added for the 7 such blocks corpus-wide.
    {
      code: IN_FUNCTION_BLOCK,
      errors: [{ messageId: 'tooManyLines', data: { lines: 25, max: 15 } }],
    },
    // #16 — BOTH budgets can report on ONE block (the `define.tsx:37` overlap case): 20 lines
    // of prose plus a 12-line `@example` trips each budget independently.
    {
      code: [
        '/**',
        ...fillerLines(19),
        ' * @example',
        ...Array.from({ length: 10 }, (_, index) => {
          return ` * const step${index + 1} = run(${index + 1})`
        }),
        ' */',
        'export const run = () => {}',
      ].join('\n'),
      errors: [
        { messageId: 'tooManyLines', data: { lines: 20, max: 15 } },
        { messageId: 'exampleTooLong', data: { lines: 12, max: 10 } },
      ],
    },
    // #17 — options are honoured in both directions: a 10-line block trips `maxLines: 9`.
    {
      code: `${proseBlock(10)}\nexport const fn = () => {}`,
      options: [{ maxLines: 9 }],
      errors: [{ messageId: 'tooManyLines', data: { lines: 10, max: 9 } }],
    },
  ],
})
