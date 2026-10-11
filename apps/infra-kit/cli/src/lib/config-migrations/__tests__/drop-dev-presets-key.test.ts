import { describe, expect, it } from 'vitest'

import { dropDevPresetsKeyMigration } from '../migrations/drop-dev-presets-key'

const { apply, note } = dropDevPresetsKeyMigration

describe('drop-dev-presets-key', () => {
  it('removes only the top-level key, siblings and their order intact', () => {
    const { changed, result } = apply({
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      devServersPresets: { shopLocal: { apps: { 'shop/api': {}, 'shop/ui': {} } } },
      aliasRepo: 'p',
    })

    expect(changed).toBe(true)
    expect(result).not.toHaveProperty('devServersPresets')
    expect(Object.keys(result)).toEqual(['envManagement', 'aliasRepo'])
  })

  it('does not mutate the input', () => {
    const parsed = { devServersPresets: { shopLocal: {} } }

    apply(parsed)

    expect(parsed).toHaveProperty('devServersPresets')
  })

  it('returns the same reference and changed:false when the key is absent', () => {
    const parsed = { worktrees: { openInOrca: true } }

    expect(apply(parsed)).toEqual({ changed: false, result: parsed })
    expect(apply(parsed).result).toBe(parsed)
  })

  it('points at the app-name form of `infra-kit dev`', () => {
    expect(note).toContain('infra-kit dev <app>')
  })
})
