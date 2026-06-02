import { describe, expect, it } from 'vitest'

import { matchesAnyGlob } from '../path-match'

describe('matchesAnyGlob', () => {
  it('returns false for an empty pattern list', () => {
    expect(matchesAnyGlob('/repo/src/comp.tsx', [])).toBe(false)
  })

  it('matches a `**` segment anywhere in the path', () => {
    expect(matchesAnyGlob('/repo/src/features/user/comp.tsx', ['**/features/**'])).toBe(true)
    expect(matchesAnyGlob('/repo/src/components/comp.tsx', ['**/features/**'])).toBe(false)
  })

  it('treats `*` as a single path segment', () => {
    expect(matchesAnyGlob('apps/client/ui/x.tsx', ['apps/*/ui/**'])).toBe(true)
    expect(matchesAnyGlob('apps/a/b/ui/x.tsx', ['apps/*/ui/**'])).toBe(false)
  })

  it('matches a file extension glob', () => {
    expect(matchesAnyGlob('/repo/src/Comp.tsx', ['*.tsx'])).toBe(true)
    expect(matchesAnyGlob('/repo/src/Comp.ts', ['*.tsx'])).toBe(false)
  })

  it('normalizes Windows-style separators', () => {
    expect(matchesAnyGlob('C:\\repo\\src\\features\\x.tsx', ['**/features/**'])).toBe(true)
  })

  it('returns true when any pattern in the list matches', () => {
    expect(matchesAnyGlob('/repo/src/pages/home.tsx', ['**/features/**', '**/pages/**'])).toBe(true)
  })
})
