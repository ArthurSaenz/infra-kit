import { describe, expect, it } from 'vitest'

import { DEFAULT_RULES, ROOT_DEFAULT_RULES, defineConfig, resolvePackageConfig } from '../package-config'
import type { InfraKitPackageConfig } from '../package-config'
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

  it('accepts a full dev.proxy config and leaves resolvePackageConfig output unchanged', () => {
    const config: InfraKitPackageConfig = {
      dev: {
        proxy: {
          templates: {
            local: 'http://localhost:<port>',
            cloud: 'https://<release>-<packageName>.<env>.example.com',
          },
          routes: {
            '/api': { packageName: '@app/backend', from: ['local', 'cloud'], default: 'cloud' },
            '/media': { packageName: '@app/media', from: ['cloud'] },
          },
        },
      },
    }

    // Same shape typed through the public `defineConfig` entry point.
    expect(defineConfig(config)).toBe(config)

    const parsed = packageConfigSchema.safeParse(config)

    expect(parsed.success).toBe(true)
    // `dev` is inert to the audit: resolved rules match a config with no `dev` key.
    expect(resolvePackageConfig(config)).toEqual(resolvePackageConfig({}))
  })

  it('rejects an empty `from` array in a proxy route', () => {
    const result = packageConfigSchema.safeParse({
      dev: {
        proxy: {
          templates: { local: 'l', cloud: 'c' },
          routes: { '/api': { packageName: '@app/backend', from: [] } },
        },
      },
    })

    expect(result.success).toBe(false)
  })

  it('rejects an unknown key inside a proxy route', () => {
    const result = packageConfigSchema.safeParse({
      dev: {
        proxy: {
          templates: { local: 'l', cloud: 'c' },
          routes: { '/api': { packageName: '@app/backend', from: ['local'], foo: true } },
        },
      },
    })

    expect(result.success).toBe(false)
  })

  it('accepts a single-source proxy route with no `default`', () => {
    const result = packageConfigSchema.safeParse({
      dev: {
        proxy: {
          templates: { local: 'l', cloud: 'c' },
          routes: { '/media': { packageName: '@app/media', from: ['cloud'] } },
        },
      },
    })

    expect(result.success).toBe(true)
  })

  it('rejects a proxy route whose `default` is not listed in `from`', () => {
    const result = packageConfigSchema.safeParse({
      dev: {
        proxy: {
          templates: { local: 'l', cloud: 'c' },
          routes: { '/api': { packageName: '@app/backend', from: ['cloud'], default: 'local' } },
        },
      },
    })

    expect(result.success).toBe(false)
  })

  it('rejects a proxy route missing the required `default`', () => {
    const result = packageConfigSchema.safeParse({
      dev: {
        proxy: {
          templates: { local: 'l', cloud: 'c' },
          routes: { '/api': { packageName: '@app/backend', from: ['local', 'cloud'] } },
        },
      },
    })

    expect(result.success).toBe(false)
  })

  it('accepts a proxy route whose `default` is listed in `from`', () => {
    const result = packageConfigSchema.safeParse({
      dev: {
        proxy: {
          templates: { local: 'l', cloud: 'c' },
          routes: { '/api': { packageName: '@app/backend', from: ['local', 'cloud'], default: 'local' } },
        },
      },
    })

    expect(result.success).toBe(true)
  })

  it('accepts a config with no dev key (backwards compatible)', () => {
    const result = packageConfigSchema.safeParse({ requiredScripts: ['build'] })

    expect(result.success).toBe(true)
  })

  it('rejects an unknown key inside dev (strict)', () => {
    const result = packageConfigSchema.safeParse({ dev: { prot: 3010 } })

    expect(result.success).toBe(false)
  })
})
