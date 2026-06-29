import { describe, expect, it } from 'vitest'

import config from '../src/index.js'

// AC11 — consumer extension via `rules` and `userConfigs`, appended LAST so they win. Empty `rules`
// adds nothing (preserving the default call shape). Assertions check position (last) + content via a
// distinguishing field, not full-object identity, so they survive antfu leaving anon configs untouched.
describe('options: rules + userConfigs passthrough', () => {
  it('appends a trailing rules item as the last config when non-empty', async () => {
    const base = await config()
    const withRules = await config({ rules: { 'no-console': 'error' } })

    expect(withRules.length).toBe(base.length + 1)
    expect(withRules.at(-1)?.rules?.['no-console']).toBe('error')
  })

  it('adds no rules item when rules is empty (default call shape preserved)', async () => {
    const base = await config()
    const withEmpty = await config({ rules: {} })

    expect(withEmpty.length).toBe(base.length)
  })

  it('appends userConfigs as the last items', async () => {
    const base = await config()
    const extra = { files: ['**/*.foo'], rules: { 'no-console': 'warn' } }
    const withUser = await config({ userConfigs: [extra] })

    expect(withUser.length).toBe(base.length + 1)
    expect(withUser.at(-1)?.files).toContain('**/*.foo')
  })
})
