import { describe, expect, it } from 'vitest'

import { antfuBaseOptions } from '../src/configs/base.js'
import config from '../src/index.js'
import { resolveOptions } from '../src/options.js'

// AC8 — the defaults invariant. resolveOptions is the single source of defaults; if any default here
// changes, the zero-drift baseline for the existing consumers changes too. These assertions pin the
// historical behavior: react mode, no extra ignores, boundaries at 'warn', every layer on, and empty
// rules/userConfigs (so the factory adds no trailing args to the antfu call).
describe('options: defaults invariant', () => {
  it('resolveOptions({}) applies the historical defaults exactly', () => {
    expect(resolveOptions({})).toEqual({
      mode: 'react',
      ignores: [],
      boundaries: 'warn',
      jsdoc: true,
      markdown: true,
      components: true,
      rules: {},
      userConfigs: [],
    })
  })

  it('resolveOptions({ ignores }) keeps defaults and applies the ignores', () => {
    expect(resolveOptions({ ignores: ['x'] })).toMatchObject({ mode: 'react', boundaries: 'warn', ignores: ['x'] })
  })

  it('normalizes boundaries: undefined/true -> warn, false stays false, error stays error', () => {
    expect(resolveOptions({}).boundaries).toBe('warn')
    expect(resolveOptions({ boundaries: true }).boundaries).toBe('warn')
    expect(resolveOptions({ boundaries: false }).boundaries).toBe(false)
    expect(resolveOptions({ boundaries: 'error' }).boundaries).toBe('error')
  })

  it('the antfu base options always carry lessOpinionated: true', () => {
    expect(antfuBaseOptions).toMatchObject({ lessOpinionated: true })
  })

  it('default config() resolves to a non-empty flat-config array', async () => {
    const flat = await config()

    expect(Array.isArray(flat)).toBe(true)
    expect(flat.length).toBeGreaterThan(0)
  })
})
