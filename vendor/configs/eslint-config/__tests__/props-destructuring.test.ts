import { describe, expect, it } from 'vitest'

import config from '../index.js'

// The RULE's behavior (inline flagged, body clean, hooks ignored, auto-fix, edge cases) is owned
// by the plugin's own RuleTester suite in @slip-stream-kit/eslint-plugin. This package only needs
// to prove the rule is WIRED INTO the exported config — turned on at error level for consumers —
// which the plugin tests cannot know. Mirrors the `config integrity` blocks in the sibling suites.
describe('props-destructuring-newline: config integrity', () => {
  it('enables the rule as an error on the @wl JSX/TSX block', async () => {
    const flat = await config()
    const withWl = flat.find((c) => c?.rules?.['@wl/props-destructuring-newline'])

    expect(withWl).toBeDefined()
    expect(withWl?.rules?.['@wl/props-destructuring-newline']).toBe('error')
  })
})
