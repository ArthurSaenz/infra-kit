import { describe, expect, it } from 'vitest'

import { stripRetiredZedIdeMigration } from '../migrations/strip-retired-zed-ide'

const { apply } = stripRetiredZedIdeMigration

// The `zed` provider is retired and the strict schema refuses it, so this migration is the only
// way a machine whose user-global config still names it gets unstuck.
describe('strip-retired-zed-ide', () => {
  it('drops a single retired zed ide entirely, preserving every other key', () => {
    const { changed, result } = apply({
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      ide: { provider: 'zed', config: {} },
      worktrees: { openInOrca: true },
    })

    expect(changed).toBe(true)
    expect(result).toEqual({
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      worktrees: { openInOrca: true },
    })
  })

  it('filters zed out of an array ide and keeps the Cursor entry', () => {
    const { changed, result } = apply({
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      ide: [
        { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
        { provider: 'zed', config: {} },
      ],
    })

    expect(changed).toBe(true)
    expect(result.ide).toEqual([{ provider: 'cursor', config: { workspaceConfigPath: 'ws' } }])
  })

  it('drops the ide key when an array held only zed (an empty array fails the schema)', () => {
    const { changed, result } = apply({
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      ide: [{ provider: 'zed', config: {} }],
    })

    expect(changed).toBe(true)
    expect(result).not.toHaveProperty('ide')
    expect(result.envManagement).toEqual({ provider: 'doppler', config: { name: 'p' } })
  })

  it('leaves a config whose only key was zed as an empty object', () => {
    expect(apply({ ide: { provider: 'zed', config: {} } })).toEqual({ changed: true, result: {} })
  })

  it('returns the same reference and changed:false when no entry names zed', () => {
    const parsed = { ide: [{ provider: 'cursor', config: { workspaceConfigPath: 'ws' } }] }

    expect(apply(parsed)).toEqual({ changed: false, result: parsed })
    expect(apply(parsed).result).toBe(parsed)
  })

  it('is a no-op when there is no ide config', () => {
    const parsed = { environments: ['dev'] }

    expect(apply(parsed).changed).toBe(false)
    expect(apply(parsed).result).toBe(parsed)
  })
})
