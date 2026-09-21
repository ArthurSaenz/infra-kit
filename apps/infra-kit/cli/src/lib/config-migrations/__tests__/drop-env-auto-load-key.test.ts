import { describe, expect, it } from 'vitest'

import { dropEnvAutoLoadKeyMigration } from '../migrations/drop-env-auto-load-key'

const { apply, note } = dropEnvAutoLoadKeyMigration

describe('drop-env-auto-load-key', () => {
  it('removes only the top-level key, siblings and their order intact', () => {
    const { changed, result } = apply({
      envAutoLoad: { enabled: true, config: 'dev' },
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      worktrees: { openInOrca: true },
    })

    expect(changed).toBe(true)
    expect(result).not.toHaveProperty('envAutoLoad')
    expect(Object.keys(result)).toEqual(['envManagement', 'worktrees'])
    expect(result.worktrees).toEqual({ openInOrca: true })
  })

  it('does not mutate the input', () => {
    const parsed = { envAutoLoad: { enabled: true, config: 'dev' } }

    apply(parsed)

    expect(parsed).toHaveProperty('envAutoLoad')
  })

  it('returns the same reference and changed:false when the key is absent', () => {
    const parsed = { worktrees: { openInOrca: true } }

    expect(apply(parsed)).toEqual({ changed: false, result: parsed })
    expect(apply(parsed).result).toBe(parsed)
  })

  it('names the manual command that replaced it', () => {
    expect(note).toContain('env-load -c')
  })
})
