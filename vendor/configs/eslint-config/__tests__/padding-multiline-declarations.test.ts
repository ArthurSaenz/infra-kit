import { describe, expect, it } from 'vitest'

import { code, expectClean, lintCase, lintCaseFixed, only } from './_lint-case.js'

const RULE = 'style/padding-line-between-statements'

describe('padding around multi-line declarations', () => {
  it('requires a blank line before and after a multi-line declaration', async () => {
    const messages = await lintCase({
      source: code`
        export const f = (define: (x: object) => object) => {
          const runs = 0
          const quick = define({
            name: 'quick',
          })
          const total = runs + 1

          return { quick, total }
        }
      `,
      fileName: 'src/x.ts',
    })

    expect(only(messages, RULE).map((m) => m.line)).toEqual([3, 6])
  })

  it('still allows consecutive single-line declarations', async () => {
    const messages = await lintCase({
      source: code`
        export const f = () => {
          const a = 1
          const b = 2

          return a + b
        }
      `,
      fileName: 'src/x.ts',
    })

    expectClean(messages, RULE)
  })

  it('autofixes by inserting the blank lines', async () => {
    const fixed = await lintCaseFixed({
      source: code`
        export const f = (define: (x: object) => object) => {
          const runs = 0
          const quick = define({
            name: 'quick',
          })
          const total = runs + 1

          return { quick, total }
        }
      `,
      fileName: 'src/x.ts',
    })

    expect(fixed).toContain('const runs = 0\n\n  const quick')
    expect(fixed).toContain('})\n\n  const total')
  })
})
