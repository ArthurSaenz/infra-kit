import { describe, it } from 'vitest'

import { code, expectAtLeastOne, expectClean, lintCase } from './_lint-case.js'

// Rule behavior belongs to @shadcn/lint's own suite; this only proves the rule is wired for consumers.
describe('shadcn/no-arbitrary-values: wired into the exported config', () => {
  it('flags an arbitrary Tailwind value in a TSX className', async () => {
    const messages = await lintCase({
      fileName: 'src/card.tsx',
      source: code`
        export const Card = () => <div className="p-[13px]" />
      `,
    })

    expectAtLeastOne(messages, 'shadcn/no-arbitrary-values')
  })

  it('passes a scale value', async () => {
    const messages = await lintCase({
      fileName: 'src/card.tsx',
      source: code`
        export const Card = () => <div className="p-4" />
      `,
    })

    expectClean(messages, 'shadcn/no-arbitrary-values')
  })
})
