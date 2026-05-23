import { describe, expect, it } from 'vitest'

import { DEFAULT_RULES, ROOT_DEFAULT_RULES, defineConfig, resolvePackageConfig } from '../package-config'
import { packageConfigSchema } from '../package-config-schema'

describe('defineConfig', () => {
  it('returns an object input unchanged (identity)', () => {
    const input = { requiredScripts: ['build'] }

    expect(defineConfig(input)).toBe(input)
  })

  it('returns a factory input unchanged so the loader can resolve it', () => {
    const factory = () => {
      return { requiredFiles: ['a.txt'] }
    }

    expect(defineConfig(factory)).toBe(factory)
  })
})

describe('resolvePackageConfig', () => {
  it('falls back to defaults for every unset key', () => {
    const rules = resolvePackageConfig({})

    expect(rules.requiredScripts).toEqual(DEFAULT_RULES.requiredScripts)
    expect(rules.requiredFiles).toEqual(DEFAULT_RULES.requiredFiles)
  })

  it('replaces a key wholesale when provided, including an empty array opt-out', () => {
    const rules = resolvePackageConfig({ requiredScripts: [], requiredFiles: ['serverless.common.yml'] })

    expect(rules.requiredScripts).toEqual([])
    expect(rules.requiredFiles).toEqual(['serverless.common.yml'])
  })

  it('does not share the default array reference with the resolved result', () => {
    const rules = resolvePackageConfig({})

    rules.requiredScripts.push('mutated')

    expect(DEFAULT_RULES.requiredScripts).not.toContain('mutated')
  })

  it('falls back to the supplied baseline (root) for unset keys, including turbo tasks', () => {
    const rules = resolvePackageConfig({}, ROOT_DEFAULT_RULES)

    expect(rules.requiredScripts).toEqual(ROOT_DEFAULT_RULES.requiredScripts)
    expect(rules.turboTasks).toEqual(ROOT_DEFAULT_RULES.turboTasks)
  })

  it('lets a config override turbo.requiredTasks', () => {
    const rules = resolvePackageConfig({ turbo: { requiredTasks: ['build'] } }, ROOT_DEFAULT_RULES)

    expect(rules.turboTasks).toEqual(['build'])
  })

  it('defaults turboTasks to an empty array for packages', () => {
    const rules = resolvePackageConfig({})

    expect(rules.turboTasks).toEqual([])
  })
})

describe('packageConfigSchema', () => {
  it('rejects unknown keys so config typos surface as errors', () => {
    const result = packageConfigSchema.safeParse({ requiredScript: ['build'] })

    expect(result.success).toBe(false)
  })

  it('rejects a non-array requiredScripts', () => {
    const result = packageConfigSchema.safeParse({ requiredScripts: 'build' })

    expect(result.success).toBe(false)
  })

  it('accepts a well-formed config', () => {
    const result = packageConfigSchema.safeParse({ requiredScripts: ['build'], requiredFiles: ['tsconfig.json'] })

    expect(result.success).toBe(true)
  })

  it('accepts a turbo.requiredTasks block', () => {
    const result = packageConfigSchema.safeParse({ turbo: { requiredTasks: ['build', 'validate'] } })

    expect(result.success).toBe(true)
  })

  it('rejects an unknown key inside turbo', () => {
    const result = packageConfigSchema.safeParse({ turbo: { tasks: ['build'] } })

    expect(result.success).toBe(false)
  })
})
