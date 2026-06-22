import { expect, it } from 'vitest'

import { code, expectAtLeastOne, expectClean, lintCase } from './_lint-case.js'

// The RULE's own behavior is owned by the plugin's RuleTester suite. This package only proves the
// exported config WIRES it correctly: `@wl/component-file-order` is OFF on `*.stories.tsx` (stories
// legitimately deviate from imports → *Props → component order) but ON for an ordinary `.tsx` with
// byte-identical content. The only differentiator is the filename glob, so both cases lint the same
// inline source under two virtual `fileName`s.
const RULE = '@wl/component-file-order'

// Wrong order: a stray const wedged before the component, mirroring the former Bad.tsx fixture.
const WRONG = code`
  import type { ReactElement } from 'react'

  interface BadProps {
    label: string
  }

  const SOME_CONSTANT = 'wedge'

  function Bad(props: BadProps): ReactElement {
    const { label } = props

    return <div>{label}</div>
  }

  export { Bad, SOME_CONSTANT }
`

it('skips component-file-order on *.stories.tsx (rule disabled for stories)', async () => {
  expectClean(await lintCase({ source: WRONG, fileName: 'src/Bad.stories.tsx' }), RULE)
})

// POSITIVE CONTROL — same content under a plain `.tsx` must still be flagged. Kept as ">= 1" to avoid
// coupling to the plugin's exact messageId set.
it('still enforces component-file-order on a non-story .tsx with identical content (control)', async () => {
  expectAtLeastOne(await lintCase({ source: WRONG, fileName: 'src/Bad.tsx' }), RULE)
})

// Self-falsifying guard: a mistyped/ignored virtual path must THROW, not silently report clean.
it('meta: an ignored/typo virtual path throws, not silently clean', async () => {
  await expect(lintCase({ source: WRONG, fileName: '.omc/ignored.tsx' })).rejects.toThrow()
})
