import { describe, it } from 'vitest'

import { code, expectClean, lintCase } from './_lint-case.js'

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
