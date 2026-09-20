import { describe, expect, it } from 'vitest'

import { dropEnvironmentsKeyMigration } from '../migrations/drop-environments-key'

const { apply, note } = dropEnvironmentsKeyMigration

describe('drop-environments-key', () => {
  it('removes only the top-level key, siblings and their order intact', () => {
    const { changed, result } = apply({
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      environments: ['dev', 'staging'],
      ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
    })

    expect(changed).toBe(true)
    expect(result).not.toHaveProperty('environments')
    expect(Object.keys(result)).toEqual(['envManagement', 'ide'])
    expect(result.envManagement).toEqual({ provider: 'doppler', config: { name: 'p' } })
  })

  it('removes the key whatever its value — the strict schema refuses the key, not a value', () => {
    expect(apply({ environments: null }).result).toEqual({})
    expect(apply({ environments: 'dev' }).result).toEqual({})
  })

  it('does not mutate the input', () => {
    const parsed = { environments: ['dev'] }

    apply(parsed)

    expect(parsed).toHaveProperty('environments')
  })

  it('returns the same reference and changed:false when the key is absent', () => {
    const parsed = { envManagement: { provider: 'doppler', config: { name: 'p' } } }

    expect(apply(parsed)).toEqual({ changed: false, result: parsed })
    expect(apply(parsed).result).toBe(parsed)
  })

  it('names where the key went, so nobody re-adds it', () => {
    expect(note).toContain('workflow_dispatch')
    expect(note).toContain('token store')
  })
})
