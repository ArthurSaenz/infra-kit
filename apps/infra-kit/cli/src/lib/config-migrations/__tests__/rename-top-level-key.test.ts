import { describe, expect, it } from 'vitest'

import { renameTopLevelKey } from '../migrations/rename-top-level-key'

const migration = renameTopLevelKey({ from: 'old', to: 'renamed', id: 'rename-old', note: 'note', toVersion: 2 })

describe('renameTopLevelKey', () => {
  it('moves the value to the new key in place, keeping sibling order', () => {
    const { changed, result } = migration.apply({ a: 1, old: { x: true }, b: 2 })

    expect(changed).toBe(true)
    expect(Object.entries(result)).toEqual([
      ['a', 1],
      ['renamed', { x: true }],
      ['b', 2],
    ])
  })

  it('hands back the same reference when the old key is absent, so a second pass is a no-op', () => {
    const input = { renamed: 1 }

    expect(migration.apply(input)).toEqual({ changed: false, result: input })
    expect(migration.apply(input).result).toBe(input)
  })

  it('leaves a file carrying both keys alone rather than dropping one of the values', () => {
    const input = { old: 1, renamed: 2 }

    expect(migration.apply(input).result).toBe(input)
  })

  it('declares its kind and the version it introduces', () => {
    expect(migration).toMatchObject({ kind: 'rename', toVersion: 2 })
  })
})
