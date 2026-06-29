import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { requireJsdocExample } from '../require-jsdoc-example'

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
      ecmaFeatures: { jsx: true },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
})

// Most cases use tiny explicit thresholds so fixtures stay minimal. Cognitive complexity:
//   COMPLEXITY_0 — a flat function (no control flow) → 0.
//   COMPLEXITY_1 — a single top-level `if` → 1.
//   COMPLEXITY_2 — a single `if` whose test is `a && b` → 1 (`if`) + 1 (`&&` run) = 2.
const COMPLEXITY_0 = 'function flat(a) { return a + 1 }'

const COMPLEXITY_1_BODY = dedent`
  function one(a) {
    if (a) {
      return 1
    }
    return 0
  }
`

const COMPLEXITY_2_BODY = dedent`
  function two(a, b) {
    if (a && b) {
      return 1
    }
    return 0
  }
`

// Deeply nested ifs inside a loop. Cognitive complexity per the SonarSource model:
//   for (+1) + if@1 (+2) + if@2 (+3) + if@3 (+4) + if@4 (+5) = 15 (>= the default 12).
const DEEP_NESTED_BODY = dedent`
  function deep(a, b, c, d) {
    for (const x of a) {
      if (b) {
        if (c) {
          if (d) {
            if (a) {
              return 1
            }
          }
        }
      }
    }
    return 0
  }
`

ruleTester.run('require-jsdoc-example', requireJsdocExample, {
  valid: [
    // #1 — complexity (0) below `minComplexity`: no JSDoc required.
    { code: COMPLEXITY_0, options: [{ minComplexity: 1, exampleComplexity: 2 }] },
    // #2 — LOAD-BEARING: complexity 1 sits in [min, example); a plain JSDoc block
    // (no `@example`) satisfies the requirement.
    {
      code: dedent`
        /**
         * Does a thing.
         */
        function one(a) {
          if (a) {
            return 1
          }
          return 0
        }
      `,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
    },
    // #3 — complexity 2 (>= exampleComplexity) WITH a block that includes `@example`.
    {
      code: dedent`
        /**
         * @example
         * two(1, 2)
         */
        function two(a, b) {
          if (a && b) {
            return 1
          }
          return 0
        }
      `,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
    },
    // #4 — `@example` block placed before the `export` wrapper still counts.
    {
      code: dedent`
        /**
         * @example
         * usage(1, 2)
         */
        export function usage(a, b) {
          if (a && b) {
            return 1
          }
          return 0
        }
      `,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
    },
    // #5 — `ignore` wins: a would-be violation skipped by the ignore glob.
    {
      code: COMPLEXITY_1_BODY,
      filename: 'src/ignored/one.ts',
      options: [{ minComplexity: 1, exampleComplexity: 2, ignore: ['**/ignored/**'] }],
    },
    // #6 — `paths` excludes a non-matching file.
    {
      code: COMPLEXITY_1_BODY,
      filename: 'src/other/one.ts',
      options: [{ minComplexity: 1, exampleComplexity: 2, paths: ['**/included/**'] }],
    },
    // #7 — object methods are not targeted (only top-level named functions are).
    {
      code: dedent`
        const obj = {
          doThing(a, b) {
            if (a && b) {
              return 1
            }
            return 0
          },
        }
      `,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
    },
    // #8 — DEFAULT thresholds (8/12): complexity 15 WITH an `@example` block is valid.
    {
      code: dedent`
        /**
         * @example
         * deep([], 1, 2, 3)
         */
        function deep(a, b, c, d) {
          for (const x of a) {
            if (b) {
              if (c) {
                if (d) {
                  if (a) {
                    return 1
                  }
                }
              }
            }
          }
          return 0
        }
      `,
    },
  ],
  invalid: [
    // #9 — anonymous inline callbacks are NOT separately targeted: the enclosing
    // named `Outer` is reported exactly once (its score includes the callback's),
    // and the inline `(item) => …` is never a second target.
    {
      code: dedent`
        const Outer = (items) => {
          return items.map((item) => {
            if (item.a && item.b) {
              return 1
            }
            return 0
          })
        }
      `,
      options: [{ minComplexity: 1, exampleComplexity: 99 }],
      errors: [{ messageId: 'missingJsdoc', data: { name: 'Outer', complexity: 3, minComplexity: 1 } }],
    },
    // #10 — complexity 1 in [min, example) with NO block → missingJsdoc.
    {
      code: COMPLEXITY_1_BODY,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
      errors: [{ messageId: 'missingJsdoc', data: { name: 'one', complexity: 1, minComplexity: 1 } }],
    },
    // #11 — complexity 2 (>= exampleComplexity) with NO block → missingJsdoc (precedence).
    {
      code: COMPLEXITY_2_BODY,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
      errors: [{ messageId: 'missingJsdoc', data: { name: 'two', complexity: 2, minComplexity: 1 } }],
    },
    // #12 — complexity 2 (>= exampleComplexity) with a block but NO `@example` → missingExample.
    {
      code: dedent`
        /**
         * Does a thing.
         */
        function two(a, b) {
          if (a && b) {
            return 1
          }
          return 0
        }
      `,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
      errors: [{ messageId: 'missingExample', data: { name: 'two', complexity: 2, exampleComplexity: 2 } }],
    },
    // #13 — a non-JSDoc block comment (`/* … */`) does not count as a block.
    {
      code: dedent`
        /* @example one(1) */
        function one(a) {
          if (a) {
            return 1
          }
          return 0
        }
      `,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
      errors: [{ messageId: 'missingJsdoc', data: { name: 'one', complexity: 1, minComplexity: 1 } }],
    },
    // #14 — `paths` matches → reported.
    {
      code: COMPLEXITY_1_BODY,
      filename: 'src/included/one.ts',
      options: [{ minComplexity: 1, exampleComplexity: 2, paths: ['**/included/**'] }],
      errors: [{ messageId: 'missingJsdoc', data: { name: 'one', complexity: 1, minComplexity: 1 } }],
    },
    // #15 — exported `const` arrow variant → missingJsdoc.
    {
      code: dedent`
        export const Widget = (a, b) => {
          if (a && b) {
            return 1
          }
          return 0
        }
      `,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
      errors: [{ messageId: 'missingJsdoc', data: { name: 'Widget', complexity: 2, minComplexity: 1 } }],
    },
    // #16 — exported `function` declaration variant → missingJsdoc.
    {
      code: dedent`
        export function helper(a) {
          if (a) {
            return 1
          }
          return 0
        }
      `,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
      errors: [{ messageId: 'missingJsdoc', data: { name: 'helper', complexity: 1, minComplexity: 1 } }],
    },
    // #17 — `export default function` variant (named) → missingJsdoc.
    {
      code: dedent`
        export default function main(a) {
          if (a) {
            return 1
          }
          return 0
        }
      `,
      options: [{ minComplexity: 1, exampleComplexity: 2 }],
      errors: [{ messageId: 'missingJsdoc', data: { name: 'main', complexity: 1, minComplexity: 1 } }],
    },
    // #18 — DEFAULT thresholds (8/12): complexity 15 with NO block → missingJsdoc.
    {
      code: DEEP_NESTED_BODY,
      errors: [{ messageId: 'missingJsdoc', data: { name: 'deep', complexity: 15, minComplexity: 8 } }],
    },
    // #19 — DEFAULT thresholds (8/12): complexity 15 with a block but NO `@example` → missingExample.
    {
      code: dedent`
        /**
         * Walks nested branches.
         */
        function deep(a, b, c, d) {
          for (const x of a) {
            if (b) {
              if (c) {
                if (d) {
                  if (a) {
                    return 1
                  }
                }
              }
            }
          }
          return 0
        }
      `,
      errors: [{ messageId: 'missingExample', data: { name: 'deep', complexity: 15, exampleComplexity: 12 } }],
    },
  ],
})
