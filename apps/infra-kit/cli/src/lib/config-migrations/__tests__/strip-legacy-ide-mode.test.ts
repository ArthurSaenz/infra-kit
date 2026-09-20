import { describe, expect, it } from 'vitest'

import { stripLegacyIdeModeMigration } from '../migrations/strip-legacy-ide-mode'

const { apply } = stripLegacyIdeModeMigration

describe('strip-legacy-ide-mode', () => {
  it('strips a legacy ide.config.mode (single provider) and preserves the rest', () => {
    const parsed = {
      environments: ['dev'],
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: './ws.code-workspace' } },
    }

    const { changed, result } = apply(parsed)

    expect(changed).toBe(true)
    expect(result.ide).toEqual({ provider: 'cursor', config: { workspaceConfigPath: './ws.code-workspace' } })
    // Everything else preserved verbatim.
    expect(result.environments).toEqual(['dev'])
    expect(result.envManagement).toEqual({ provider: 'doppler', config: { name: 'p' } })
  })

  it('strips ide.config.mode from every entry of an array ide', () => {
    const { changed, result } = apply({
      environments: ['dev'],
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      ide: [
        { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws' } },
        { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws2' } },
      ],
    })

    expect(changed).toBe(true)
    expect(result.ide).toEqual([
      { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
      { provider: 'cursor', config: { workspaceConfigPath: 'ws2' } },
    ])
  })

  it('strips a `windows` mode the same way', () => {
    const { result } = apply({ ide: { provider: 'cursor', config: { mode: 'windows', workspaceConfigPath: 'ws' } } })

    expect(result.ide).toEqual({ provider: 'cursor', config: { workspaceConfigPath: 'ws' } })
  })

  it('does not mutate the input object', () => {
    const parsed = { ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws' } } }

    apply(parsed)

    expect(parsed.ide.config).toHaveProperty('mode', 'workspace')
  })

  it('returns the same reference and changed:false for an already-clean ide', () => {
    const parsed = {
      environments: ['dev'],
      ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
    }

    expect(apply(parsed)).toEqual({ changed: false, result: parsed })
    expect(apply(parsed).result).toBe(parsed)
  })

  it('is a no-op when there is no ide config', () => {
    const parsed = { environments: ['dev'], envManagement: { provider: 'doppler', config: { name: 'p' } } }

    expect(apply(parsed).changed).toBe(false)
    expect(apply(parsed).result).toBe(parsed)
  })

  it('is a no-op when ide is not an object', () => {
    const parsed = { ide: 'cursor' }

    expect(apply(parsed).changed).toBe(false)
    expect(apply(parsed).result).toBe(parsed)
  })
})
