import { describe, expect, it } from 'vitest'

import { dropIdeKeyMigration } from '../migrations/drop-ide-key'

const { apply, note } = dropIdeKeyMigration

describe('drop-ide-key', () => {
  it('removes only the top-level key, siblings and their order intact', () => {
    const { changed, result } = apply({
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      ide: { provider: 'cursor', config: { workspaceConfigPath: './ws.code-workspace' } },
      aliasRepo: 'p',
    })

    expect(changed).toBe(true)
    expect(result).not.toHaveProperty('ide')
    expect(Object.keys(result)).toEqual(['envManagement', 'aliasRepo'])
  })

  // Every historical shape goes, including the ones older migrations used to reshape in place.
  it.each([
    [[{ provider: 'cursor', config: { workspaceConfigPath: 'ws' } }]],
    [{ provider: 'zed', config: {} }],
    [{ provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws' } }],
  ])('drops the %j shape', (ide) => {
    expect(apply({ ide })).toEqual({ changed: true, result: {} })
  })

  it('does not mutate the input', () => {
    const parsed = { ide: { provider: 'cursor' } }

    apply(parsed)

    expect(parsed).toHaveProperty('ide')
  })

  it('returns the same reference and changed:false when the key is absent', () => {
    const parsed = { worktrees: { openInOrca: true } }

    expect(apply(parsed)).toEqual({ changed: false, result: parsed })
    expect(apply(parsed).result).toBe(parsed)
  })

  it('names the editor integration that went away', () => {
    expect(note).toContain('Cursor')
  })
})
