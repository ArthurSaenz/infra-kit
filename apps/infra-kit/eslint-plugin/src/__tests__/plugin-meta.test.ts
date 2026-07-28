import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import wl, { rules } from '../index'

// `plugin.meta.version` is hand-written and has already drifted from `package.json` once (it sat at
// 0.1.20 against a published 0.1.21), which silently mislabels every report ESLint attributes to the
// plugin. Read at runtime rather than imported: `composite: true` requires every file in the TS
// program to be inside `include`, and `package.json` is not.
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }

const recommended = wl.configs.recommended ?? []
const presetBlocks = Array.isArray(recommended) ? recommended : [recommended]

const presetRuleIds = presetBlocks.flatMap((block) => {
  return Object.keys(block.rules ?? {})
})

describe('plugin meta', () => {
  it('declares the same version as package.json', () => {
    expect(wl.meta?.version).toBe(pkg.version)
  })
})

describe('max-jsdoc-lines registration', () => {
  it('is registered in the rule map', () => {
    expect(rules['max-jsdoc-lines']).toBeDefined()
  })

  // DELIBERATE OMISSION, asserted so it cannot be "fixed" by accident. The preset registers its
  // rules under the components gate, which carries no `ignores` — enabling `max-jsdoc-lines` there
  // would give one policy two switches and re-expose test/story/`.d.ts` files the config layer's
  // `GLOB_TS_DOC_EXCLUDE` deliberately excludes. It ships behind the `o.jsdoc` gate in
  // `configs/docs.ts` instead, which owns its severity outright.
  it('is NOT enabled by the recommended preset', () => {
    expect(presetRuleIds).not.toContain('@wl/max-jsdoc-lines')
  })
})
