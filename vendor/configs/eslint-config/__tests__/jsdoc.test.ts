import { describe, expect, it } from 'vitest'

import { code, expectClean, expectFlagged, lintCase, lintCaseFixed, only } from './_lint-case.js'

// Function-level JSDoc enforcement was handed off from the off-the-shelf `jsdoc/*` rules to the custom
// `@wl/require-jsdoc-example` rule (graduated cognitive-complexity gate). The three off-the-shelf rules
// — require-jsdoc, require-description, require-example — are now disabled in src/configs/docs.ts, so
// none of them may fire on ANY shape. Each fixture below is one that USED to flag under the old layer
// (a bare-block lowercase function for the content rules; a block-less >15-line function or property
// for require-jsdoc); they now assert silence. Fixtures live at non-excluded virtual paths, so were the
// rules on they WOULD apply — that is what keeps these assertions non-vacuous.

const REQUIRE_DESC = 'jsdoc/require-description'
const REQUIRE_EXAMPLE = 'jsdoc/require-example'
const REQUIRE_JSDOC = 'jsdoc/require-jsdoc'

// A description-less, example-less JSDoc block: present but bare. Under the old layer this shape made
// require-description / require-example fire; with the rules off it must stay clean.
const BARE_BLOCK = '/**\n * @public\n */'

const expectNoJsdoc = (messages: Awaited<ReturnType<typeof lintCase>>) => {
  expectClean(messages, REQUIRE_JSDOC)
  expectClean(messages, REQUIRE_DESC)
  expectClean(messages, REQUIRE_EXAMPLE)
}

describe('jsdoc: off-the-shelf rules are disabled (handed off to @wl/require-jsdoc-example)', () => {
  it('lowercase arrow with a bare block — require-description/require-example stay silent', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/helper.ts',
      source: code`
        ${BARE_BLOCK}
        export const helper = () => 1
      `,
    })

    expectNoJsdoc(messages)
  })

  it('lowercase function declaration with a bare block — require-description/require-example stay silent', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/helper.ts',
      source: code`
        ${BARE_BLOCK}
        export function helper() {
          return 1
        }
      `,
    })

    expectNoJsdoc(messages)
  })

  it('block-less >15-line lowercase arrow — require-jsdoc stays silent', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/helper.ts',
      source: code`
        export const bigHelper = () => {
          const a01 = 1
          const a02 = 2
          const a03 = 3
          const a04 = 4
          const a05 = 5
          const a06 = 6
          const a07 = 7
          const a08 = 8
          const a09 = 9
          const a10 = 10
          const a11 = 11
          const a12 = 12
          const a13 = 13
          const a14 = 14
          const a15 = 15
          const a16 = 16

          return a01 + a02 + a03 + a04 + a05 + a06 + a07 + a08 + a09 + a10 + a11 + a12 + a13 + a14 + a15 + a16
        }
      `,
    })

    expectNoJsdoc(messages)
  })

  it('block-less >15-line lowercase function declaration — require-jsdoc stays silent', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/helper.ts',
      source: code`
        export function bigHelper() {
          const a01 = 1
          const a02 = 2
          const a03 = 3
          const a04 = 4
          const a05 = 5
          const a06 = 6
          const a07 = 7
          const a08 = 8
          const a09 = 9
          const a10 = 10
          const a11 = 11
          const a12 = 12
          const a13 = 13
          const a14 = 14
          const a15 = 15
          const a16 = 16

          return a01 + a02 + a03 + a04 + a05 + a06 + a07 + a08 + a09 + a10 + a11 + a12 + a13 + a14 + a15 + a16
        }
      `,
    })

    expectNoJsdoc(messages)
  })

  it('>15-line arrow assigned to an object property — require-jsdoc stays silent', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/api.ts',
      source: code`
        export const api = {
          bigHandler: () => {
            const a01 = 1
            const a02 = 2
            const a03 = 3
            const a04 = 4
            const a05 = 5
            const a06 = 6
            const a07 = 7
            const a08 = 8
            const a09 = 9
            const a10 = 10
            const a11 = 11
            const a12 = 12
            const a13 = 13
            const a14 = 14
            const a15 = 15
            const a16 = 16

            return a01 + a16
          },
        }
      `,
    })

    expectNoJsdoc(messages)
  })
})

// Layer 1 of the JSDoc size-limits work: the off-the-shelf `jsdoc/*` rules added to docs.ts
// (tag-lines, no-types + the require-*-type pair, check-line-alignment), plus the GLOB_TS_DOC_EXCLUDE
// pin. These fixtures are deliberately shaped like the real corpus (ls-slim.ts's set()/get()) rather
// than minimal reproductions, so a passing suite says something about the house-style shape and not
// just the rule engine.
describe('jsdoc: Layer 1 size-limit rules (docs.ts)', () => {
  it('tag-lines preserves the description separator but strips a blank line between tags', async () => {
    const source = code`
      /**
       * Stores a value with options.
       *
       * @param key - A key to identify the value.
       *
       * @param value - A value associated with the key.
       * @param ttl - Time to live in seconds.
       *
       * @example
       *     set('session', { token: 'abc' }, 3600)
       *
       */
      export const set = (key: string, value: unknown, ttl: number) => {
        return key + ttl + String(value)
      }
    `

    const messages = await lintCase({ fileName: 'src/lib/set.ts', source })

    expect(only(messages, 'jsdoc/tag-lines').length).toBeGreaterThanOrEqual(1)

    const fixed = await lintCaseFixed({ fileName: 'src/lib/set.ts', source })

    // The description -> first-tag separator (startLines: 1) survives the fix.
    expect(fixed).toContain('Stores a value with options.\n *\n * @param key')
    // The blank line BETWEEN @param key and @param value is gone.
    expect(fixed).toContain('@param key - A key to identify the value.\n * @param value')
    expect(fixed).not.toContain('@param key - A key to identify the value.\n *\n * @param value')
  })

  it('no-types fires on a typed @param and a typed @returns', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/length.ts',
      source: code`
        /**
         * Returns the length of a key.
         *
         * @param {string} key - A key.
         * @returns {number} The key's length.
         */
        export const length = (key: string): number => key.length
      `,
    })

    expect(only(messages, 'jsdoc/no-types').length).toBeGreaterThanOrEqual(2)
  })

  it('require-param-type and require-returns-type stay silent on untyped tags (they contradict no-types)', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/length.ts',
      source: code`
        /**
         * Returns the length of a key.
         *
         * @param key - A key.
         * @returns The key's length.
         */
        export const length = (key: string): number => key.length
      `,
    })

    expectClean(messages, 'jsdoc/require-param-type')
    expectClean(messages, 'jsdoc/require-returns-type')
  })

  it('check-line-alignment fires on a column-aligned @param table', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/combine.ts',
      source: code`
        /**
         * Combines a key and a value.
         *
         * @param key   - A key.
         * @param value - A value.
         */
        export const combine = (key: string, value: string) => key + value
      `,
    })

    expect(only(messages, 'jsdoc/check-line-alignment').length).toBeGreaterThanOrEqual(1)
  })

  // check-param-names is the one Layer 1 rule promoted from the preset's `warn` rather than added:
  // the preset ships it on, but `eslint --quiet` (every package's eslint-check script) drops warnings
  // wholesale, so it reported to nobody. The severity assertions below are therefore the point of
  // these cases — "a message exists" was already true before the promotion; `severity === 2` is not.
  it('fires at error on a `@param` left behind by a rename', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/add.ts',
      source: code`
        /**
         * Adds two numbers.
         *
         * @param oldName - The first number.
         * @param b - The second number.
         */
        export const add = (a: number, b: number) => a + b
      `,
    })

    expectFlagged(messages, 'jsdoc/check-param-names', 'Expected @param names to be "a, b". Got "oldName, b"')
    expect(only(messages, 'jsdoc/check-param-names')[0]?.severity).toBe(2)
  })

  it('stays clean when a block documents only SOME parameters — the rule adds no documentation burden', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/add.ts',
      source: code`
        /**
         * Adds two numbers.
         *
         * @param a - The first number.
         */
        export const add = (a: number, b: number) => a + b
      `,
    })

    expectClean(messages, 'jsdoc/check-param-names')
  })

  // `checkDestructured: false` is the load-bearing option: at its `true` default the rule stops being
  // a drift check and demands a `@param props.<field>` tag per destructured field — noise on every
  // component taking a props object. The stale positional block below shares the file precisely so
  // this stays non-vacuous: exactly ONE message proves the rule was live and the component silent.
  it('destructured props raise nothing, while the rule stays live in the same file', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/card.tsx',
      source: code`
        /**
         * Renders a card.
         *
         * @param props - Everything the card needs to render itself.
         */
        export const Card = ({ title, subtitle }: { title: string; subtitle: string }) => title + subtitle

        /**
         * Adds two numbers.
         *
         * @param oldName - The first number.
         * @param b - The second number.
         */
        export const add = (a: number, b: number) => a + b
      `,
    })

    expectFlagged(messages, 'jsdoc/check-param-names', 'Got "oldName, b"')
  })

  // The accepted cost of `checkDestructured: false`, pinned so it is a decision and not a surprise:
  // a destructured parameter has no name in the signature, so a stale ROOT tag has nothing to be
  // checked against. Renames of the destructured FIELDS are still covered — they must match the
  // binding names, which is the case the config actually cares about.
  it('does not report a stale ROOT name on a destructured parameter — the documented blind spot', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/combine.ts',
      source: code`
        /**
         * Combines two values.
         *
         * @param oldBag - The options bag.
         */
        export const combine = ({ a, b }: { a: string; b: string }) => a + b
      `,
    })

    expectClean(messages, 'jsdoc/check-param-names')
  })

  it('check-param-names drops back to the preset severity on a GLOB_TS_DOC_EXCLUDE path', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/add.test.ts',
      source: code`
        /**
         * Adds two numbers.
         *
         * @param oldName - The first number.
         * @param b - The second number.
         */
        export const add = (a: number, b: number) => a + b
      `,
    })

    // Not clean: antfu's preset enables the rule globally and this config's `ignores` only scopes the
    // `error` promotion. Severity 1 under `eslint --quiet` is the pre-existing silence, not a gate.
    expect(only(messages, 'jsdoc/check-param-names')[0]?.severity).toBe(1)
  })

  it('the new rules stay silent on a GLOB_TS_DOC_EXCLUDE path — non-vacuous against the no-types fixture above', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/length.test.ts',
      source: code`
        /**
         * Returns the length of a key.
         *
         * @param {string} key - A key.
         * @returns {number} The key's length.
         */
        export const length = (key: string): number => key.length
      `,
    })

    expectClean(messages, 'jsdoc/no-types')
  })
})

// Layer 2 of the JSDoc size-limits work: the custom `@wl/max-jsdoc-lines` rule, wired at `error` in
// src/configs/components.ts (the layer where the @wl plugin loads) against the JSDoc layer's globs.
// Every fixture is line-counted against the rule's own arithmetic — total is `end.line - start.line
// + 1`, an `@example` body runs from its tag line through the next tag (or the closing line), and
// prose is the remainder — so a fixture that drifts by one line fails loudly instead of silently
// landing under a ceiling. The two-budget case is the one that matters: it is what keeps this rule
// from deadlocking with `@wl/require-jsdoc-example`, which MANDATES an `@example`.
const MAX_JSDOC_LINES = '@wl/max-jsdoc-lines'

describe('jsdoc: Layer 2 size cap (@wl/max-jsdoc-lines, components.ts)', () => {
  it('fires at error on an 18-line prose block (max 15)', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/atom-types.ts',
      source: code`
        /**
         * Extracts the first argument type from a WritableAtom's write function.
         *
         * Rationale line 01 — the kind of prose that belongs in a note or the file-level block.
         * Rationale line 02.
         * Rationale line 03.
         * Rationale line 04.
         * Rationale line 05.
         * Rationale line 06.
         * Rationale line 07.
         * Rationale line 08.
         * Rationale line 09.
         * Rationale line 10.
         * Rationale line 11.
         * Rationale line 12.
         * Rationale line 13.
         * Rationale line 14.
         */
        export const extract = (value: string) => value
      `,
    })

    expectFlagged(messages, MAX_JSDOC_LINES, '18 lines of prose (max 15')
    expect(only(messages, MAX_JSDOC_LINES)[0]?.severity).toBe(2)
  })

  it('fires on a 13-line `@example` body (max 10) while the prose stays well inside its budget', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/session.ts',
      source: code`
        /**
         * Stores a session token.
         *
         * @example
         *     const store = createStore()
         *     const session = { token: 'abc' }
         *     store.set('session', session)
         *     store.set('session', session, 3600)
         *     store.get('session')
         *     store.remove('session')
         *     store.clear()
         *     store.keys()
         *     store.size()
         *     store.has('session')
         *     store.entries()
         */
        export const store = (key: string) => key
      `,
    })

    expectFlagged(messages, MAX_JSDOC_LINES, 'span 13 lines (max 10)')
  })

  it('stays clean at exactly both ceilings — 15 prose lines around a 10-line `@example`', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/combine-values.ts',
      source: code`
        /**
         * Combines a key and a value into a storage entry.
         *
         * Prose line 01.
         * Prose line 02.
         * Prose line 03.
         * Prose line 04.
         * Prose line 05.
         * Prose line 06.
         * Prose line 07.
         * Prose line 08.
         * Prose line 09.
         * Prose line 10.
         *
         * @example
         *     combine('a', 'b')
         *     combine('a', 'c')
         *     combine('b', 'c')
         *     combine('c', 'd')
         *     combine('d', 'e')
         *     combine('e', 'f')
         *     combine('f', 'g')
         */
        export const combine = (key: string, value: string) => key + value
      `,
    })

    expectClean(messages, MAX_JSDOC_LINES)
  })

  it('`@fileoverview` exempts a block that blows past both budgets', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/why-this-module.ts',
      source: code`
        /**
         * @fileoverview Why this module exists, and the three constraints it balances.
         *
         * Rationale line 01 — deliberately kept.
         * Rationale line 02.
         * Rationale line 03.
         * Rationale line 04.
         * Rationale line 05.
         * Rationale line 06.
         * Rationale line 07.
         * Rationale line 08.
         * Rationale line 09.
         * Rationale line 10.
         * Rationale line 11.
         * Rationale line 12.
         * Rationale line 13.
         * Rationale line 14.
         * Rationale line 15.
         * Rationale line 16.
         */
        export const anchor = 1
      `,
    })

    expectClean(messages, MAX_JSDOC_LINES)
  })

  it('stays silent on a GLOB_TS_DOC_EXCLUDE path — non-vacuous against the 18-line fixture above', async () => {
    const messages = await lintCase({
      fileName: 'src/lib/atom-types.test.ts',
      source: code`
        /**
         * Extracts the first argument type from a WritableAtom's write function.
         *
         * Rationale line 01 — the kind of prose that belongs in a note or the file-level block.
         * Rationale line 02.
         * Rationale line 03.
         * Rationale line 04.
         * Rationale line 05.
         * Rationale line 06.
         * Rationale line 07.
         * Rationale line 08.
         * Rationale line 09.
         * Rationale line 10.
         * Rationale line 11.
         * Rationale line 12.
         * Rationale line 13.
         * Rationale line 14.
         */
        export const extract = (value: string) => value
      `,
    })

    expectClean(messages, MAX_JSDOC_LINES)
  })
})
