import { describe, expect, it } from 'vitest'

import { slugifyRelease as slugFromEntry } from 'src/entry/vite'

import { slugifyRelease } from '../release-slug'

/**
 * The shared slug module is the single source of truth for the `<release>` hostname
 * segment (D3/REV-4). These assert the historical examples byte-for-byte AND that the
 * published `infra-kit/vite` re-export (`entry/vite.ts:7`) still resolves the same fn.
 */
describe('slugifyRelease (shared release-slug module)', () => {
  it('strips a release/ prefix and slugifies dots to dashes', () => {
    expect(slugifyRelease('release/2.4')).toBe('2-4')
  })

  it('strips a feature/ prefix and lowercases', () => {
    expect(slugifyRelease('feature/HUL-123')).toBe('hul-123')
  })

  it('slugifies a bare branch with no git-flow prefix', () => {
    expect(slugifyRelease('My_Cool.Branch')).toBe('my-cool-branch')
  })

  it('trims leading and trailing dashes', () => {
    expect(slugifyRelease('release/@2.4@')).toBe('2-4')
  })

  it('returns empty string for a branch with no alphanumeric runs', () => {
    expect(slugifyRelease('///')).toBe('')
  })
})

describe('slugifyRelease re-export chain (REV-4)', () => {
  it('the public infra-kit/vite re-export resolves to the same behaviour', () => {
    expect(typeof slugFromEntry).toBe('function')
    expect(slugFromEntry('release/2.4')).toBe('2-4')
    expect(slugFromEntry('feature/HUL-123')).toBe('hul-123')
  })
})
