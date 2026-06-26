import { describe, expect, it } from 'vitest'

import { infraKitConfigSchema, infraKitOverrideConfigSchema } from '../infra-kit-config'

const baseConfig = {
  environments: ['dev', 'prod'],
  envManagement: { provider: 'doppler', config: { name: 'my-project' } },
}

describe('envAutoLoad schema', () => {
  it('is optional — a config without it parses', () => {
    const result = infraKitConfigSchema.safeParse(baseConfig)

    expect(result.success).toBe(true)
    expect(result.success && result.data.envAutoLoad).toBeUndefined()
  })

  it.each(['shell-startup', 'cli-invocation'] as const)('accepts trigger "%s"', (trigger) => {
    const result = infraKitConfigSchema.safeParse({ ...baseConfig, envAutoLoad: { trigger, config: 'dev' } })

    expect(result.success).toBe(true)
    expect(result.success && result.data.envAutoLoad).toEqual({ trigger, config: 'dev' })
  })

  it('rejects an unknown trigger value (e.g. "both")', () => {
    const result = infraKitConfigSchema.safeParse({ ...baseConfig, envAutoLoad: { trigger: 'both', config: 'dev' } })

    expect(result.success).toBe(false)
  })

  it('rejects a missing trigger', () => {
    const result = infraKitConfigSchema.safeParse({ ...baseConfig, envAutoLoad: { config: 'dev' } })

    expect(result.success).toBe(false)
  })

  it('rejects an empty config name', () => {
    const result = infraKitConfigSchema.safeParse({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: '' },
    })

    expect(result.success).toBe(false)
  })

  it('rejects unknown keys (strict object)', () => {
    const result = infraKitConfigSchema.safeParse({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'dev', extra: true },
    })

    expect(result.success).toBe(false)
  })

  // Important: an env name not in `environments` must NOT fail the schema — it is
  // validated (and disabled) at resolve time so a typo never bricks every command.
  it('does NOT reject a config name absent from environments (resolve-time concern)', () => {
    const result = infraKitConfigSchema.safeParse({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'not-listed' },
    })

    expect(result.success).toBe(true)
  })

  it('is accepted as a partial override layer', () => {
    const result = infraKitOverrideConfigSchema.safeParse({ envAutoLoad: { trigger: 'cli-invocation', config: 'dev' } })

    expect(result.success).toBe(true)
  })
})
