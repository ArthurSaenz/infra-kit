import { describe, expect, it } from 'vitest'

import { dropDevKeyMigration } from '../migrations/drop-dev-key'

const { apply, note } = dropDevKeyMigration

describe('drop-dev-key', () => {
  it('removes only the top-level key, siblings and their order intact', () => {
    const { changed, result } = apply({
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      dev: { client: { port: 3000, prefixUrl: '/app' } },
      aliasRepo: 'p',
    })

    expect(changed).toBe(true)
    expect(result).not.toHaveProperty('dev')
    expect(Object.keys(result)).toEqual(['envManagement', 'aliasRepo'])
  })

  it('leaves the separately retired "devProxy" key to its own migration', () => {
    expect(apply({ devProxy: { port: 4443 } })).toEqual({ changed: false, result: { devProxy: { port: 4443 } } })
  })

  it('does not mutate the input', () => {
    const parsed = { dev: { client: { port: 3000 } } }

    apply(parsed)

    expect(parsed).toHaveProperty('dev')
  })

  it('returns the same reference and changed:false when the key is absent', () => {
    const parsed = { worktrees: { openInOrca: true } }

    expect(apply(parsed)).toEqual({ changed: false, result: parsed })
    expect(apply(parsed).result).toBe(parsed)
  })

  it('points at the env vars that still set the port', () => {
    expect(note).toContain('<APP>_PORT')
  })
})
