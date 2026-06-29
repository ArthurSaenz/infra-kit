import type { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

import config from '../src/index.js'

// AC9/AC10 — each group toggle drops EXACTLY its own contribution (no collateral), and the boundaries
// severity override flips only that one rule. Finders below are discriminators that uniquely identify
// OUR config items (not antfu's), so the assertions survive antfu internals shifting around them.
type Flat = Awaited<ReturnType<typeof config>>

const ourBoundaries = (flat: Flat) => flat.find((c) => c?.plugins?.boundaries)
// Our jsdoc item is the file-scoped layer that sets `jsdoc/require-jsdoc` to 'off' (function-level JSDoc
// was handed off to `@wl/require-jsdoc-example`). antfu's jsdoc layer never touches that rule, and a
// global temporarily-disabled override (if present) carries no `files`, so requiring a `files` array
// uniquely pins OUR docs.ts item.
const ourJsdoc = (flat: Flat) =>
  flat.find((c) => Array.isArray(c?.files) && c?.rules?.['jsdoc/require-jsdoc'] === 'off')
const ourMarkdown = (flat: Flat) => {
  return flat.find(
    (c) =>
      Array.isArray(c?.files) &&
      c.files.length === 1 &&
      c.files[0] === '**/*.md' &&
      Object.keys(c?.rules ?? {}).length > 100,
  )
}
const wlRule = (flat: Flat) => flat.find((c) => c?.rules?.['@wl/props-destructuring-newline'])

describe('options: group toggles drop exactly their contribution', () => {
  it('boundaries:false removes the Phase-2 boundaries item only', async () => {
    const base = await config()
    const off = await config({ boundaries: false })

    expect(ourBoundaries(base)).toBeDefined()
    expect(ourBoundaries(off)).toBeUndefined()
    expect(off.length).toBe(base.length - 1)
  })

  it("boundaries:'error' flips only the severity, keeping the item count", async () => {
    const base = await config()
    const err = await config({ boundaries: 'error' })

    expect(err.length).toBe(base.length)
    expect((ourBoundaries(base)?.rules?.['boundaries/dependencies'] as Linter.RuleEntry)?.[0]).toBe('warn')
    expect((ourBoundaries(err)?.rules?.['boundaries/dependencies'] as Linter.RuleEntry)?.[0]).toBe('error')
  })

  it('jsdoc:false removes the jsdoc item only', async () => {
    const base = await config()
    const off = await config({ jsdoc: false })

    expect(ourJsdoc(base)).toBeDefined()
    expect(ourJsdoc(off)).toBeUndefined()
    expect(off.length).toBe(base.length - 1)
  })

  it('markdown:false removes the markdown sonarjs-off item only', async () => {
    const base = await config()
    const off = await config({ markdown: false })

    expect(ourMarkdown(base)).toBeDefined()
    expect(ourMarkdown(off)).toBeUndefined()
    expect(off.length).toBe(base.length - 1)
  })

  it('components:false removes the @wl component layer', async () => {
    const base = await config()
    const off = await config({ components: false })

    expect(wlRule(base)).toBeDefined()
    expect(wlRule(off)).toBeUndefined()
    expect(off.length).toBeLessThan(base.length)
  })
})
