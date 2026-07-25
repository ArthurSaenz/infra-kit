import { describe, expect, it } from 'vitest'

import { defineConfig } from '../package-config'
import type { InfraKitPackageConfig } from '../package-config'
import { packageConfigSchema } from '../package-config-schema'

// The audit BASELINES (`DEFAULT_RULES` / `ROOT_DEFAULT_RULES`) and `resolvePackageConfig` are policy
// owned by the `infra-kit` CLI, not by this package — their tests live there. What this package owns,
// and therefore tests here, is the config-authoring surface: the identity helper and the schema that
// decides whether a consumer's `infra-kit.config.ts` is valid at all.

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

  it('accepts a full dev.proxy config authored through defineConfig', () => {
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

    expect(packageConfigSchema.safeParse(config).success).toBe(true)
  })

  it('accepts a non-https dev.proxy.templates.local (warn-first this release, see vite.ts)', () => {
    // The schema itself never rejects the scheme — `loadDev` in `../vite/vite.ts` is what warns.
    // Kept passing deliberately: making this a hard requirement is a future release, not this one.
    const result = packageConfigSchema.safeParse({
      dev: {
        proxy: {
          templates: { local: 'http://<release>.<packageName>.localhost', cloud: 'https://<env>.example.com' },
          routes: { '/api': { packageName: '@app/backend', from: ['local'] } },
        },
      },
    })

    expect(result.success).toBe(true)
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
