import { describe, expect, it } from 'vitest'

import { rebasePath, resolveCopyEntry } from '../paths'

describe('rebasePath', () => {
  const entry = resolveCopyEntry({ path: 'tools/x', target: 'vendor/x' })

  it('moves a nested source path under the target', () => {
    expect(rebasePath('tools/x/a.ts', entry)).toBe('vendor/x/a.ts')
    expect(rebasePath('tools/x/deep/b.ts', entry)).toBe('vendor/x/deep/b.ts')
  })

  it('maps the entry path itself to the target, for a single-file entry', () => {
    expect(rebasePath('tools/x', entry)).toBe('vendor/x')
  })

  it('is the identity when the target defaults to the path', () => {
    expect(rebasePath('vendor/configs/a.ts', resolveCopyEntry({ path: 'vendor/configs' }))).toBe('vendor/configs/a.ts')
  })
})

describe('resolveCopyEntry', () => {
  it.each([
    [
      { path: 'tools/x/', target: 'vendor/x/' },
      { path: 'tools/x', target: 'vendor/x', vendored: true },
    ],
    [{ path: './vendor/configs' }, { path: 'vendor/configs', target: 'vendor/configs', vendored: true }],
    [{ path: 'a//b' }, { path: 'a/b', target: 'a/b', vendored: false }],
  ])('canonicalizes %o even though the schema already refuses it', (entry, expected) => {
    expect(resolveCopyEntry(entry)).toEqual(expected)
  })

  it('rebases a trailing-slash entry into the target, not beside it', () => {
    expect(rebasePath('tools/x/a.ts', resolveCopyEntry({ path: 'tools/x/', target: 'vendor/x' }))).toBe('vendor/x/a.ts')
  })
})
