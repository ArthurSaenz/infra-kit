import { describe, expect, it } from 'vitest'

import { code, expectClean, expectFlagged, lintCase, lintCaseFixed } from './_lint-case.js'

// antfu loads unicorn but leaves this rule off; the override turns it on. Pins the rule name too —
// unicorn renamed it from `no-array-for-each`, and a stale name would silently lint nothing.
describe('unicorn/no-for-each', () => {
  it('flags .forEach()', async () => {
    const messages = await lintCase({
      source: code`
      const items = [1, 2]

      items.forEach((item) => {
        console.log(item)
      })
    `,
      fileName: 'src/x.ts',
    })

    expectFlagged(messages, 'unicorn/no-for-each', 'for…of')
  })

  it('leaves for…of clean', async () => {
    const messages = await lintCase({
      source: code`
      const items = [1, 2]

      for (const item of items) {
        console.log(item)
      }
    `,
      fileName: 'src/x.ts',
    })

    expectClean(messages, 'unicorn/no-for-each')
  })

  it('autofixes to for…of', async () => {
    const fixed = await lintCaseFixed({
      source: code`
      const items = [1, 2]

      items.forEach((item) => {
        console.log(item)
      })
    `,
      fileName: 'src/x.ts',
    })

    expect(fixed).toContain('for (const item of items)')
  })

  it('does not apply to JSON, whose language the rule does not support', async () => {
    const messages = await lintCase({ source: '{ "items": [1, 2] }\n', fileName: 'src/data.json' })

    expect(messages).toEqual([])
  })
})
