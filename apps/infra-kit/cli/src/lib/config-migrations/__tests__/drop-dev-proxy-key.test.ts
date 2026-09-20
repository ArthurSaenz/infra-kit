import { describe, expect, it } from 'vitest'

import { dropDevProxyKeyMigration } from '../migrations/drop-dev-proxy-key'

const { apply, note } = dropDevProxyKeyMigration

describe('drop-dev-proxy-key', () => {
  it('removes only the top-level key, siblings and their order intact', () => {
    const { changed, result } = apply({
      devProxy: { port: 4443 },
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      worktrees: { openInOrca: true },
    })

    expect(changed).toBe(true)
    expect(result).not.toHaveProperty('devProxy')
    expect(Object.keys(result)).toEqual(['envManagement', 'worktrees'])
    expect(result.worktrees).toEqual({ openInOrca: true })
  })

  it('does not mutate the input', () => {
    const parsed = { devProxy: { port: 4443 } }

    apply(parsed)

    expect(parsed).toHaveProperty('devProxy')
  })

  it('returns the same reference and changed:false when the key is absent', () => {
    const parsed = { worktrees: { openInOrca: true } }

    expect(apply(parsed)).toEqual({ changed: false, result: parsed })
    expect(apply(parsed).result).toBe(parsed)
  })

  it('names the port-free URL shape that replaced it', () => {
    expect(note).toContain('https://<release>.<package>.localhost')
  })
})
