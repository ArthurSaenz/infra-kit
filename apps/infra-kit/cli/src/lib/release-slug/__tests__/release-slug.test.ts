import { describe, expect, it } from 'vitest'

import { slugifyRelease as slugFromEntry } from 'src/entry/vite'

import { slugifyHostLabel, slugifyRelease } from '../release-slug'

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

describe('slugifyHostLabel (DNS-label slug for the <packageName> hostname segment)', () => {
  it('reduces a scoped npm name to a single legal label', () => {
    // portless rejects `@` and `/` outright; an unslugified scoped name silently killed both hero URLs.
    expect(slugifyHostLabel('@hulyo/client-ui')).toBe('hulyo-client-ui')
  })

  it('is idempotent for an already-valid label', () => {
    expect(slugifyHostLabel('backend-api')).toBe('backend-api')
    expect(slugifyHostLabel(slugifyHostLabel('@hulyo/client-ui'))).toBe('hulyo-client-ui')
  })

  it('does NOT strip a git-flow-looking prefix (unlike slugifyRelease)', () => {
    // A package legitimately named `fix-utils` must keep its prefix; only branches get stripped.
    expect(slugifyHostLabel('fix-utils')).toBe('fix-utils')
    expect(slugifyHostLabel('feat/thing')).toBe('feat-thing')
    expect(slugifyRelease('feat/thing')).toBe('thing')
  })

  it('emits only characters portless accepts', () => {
    expect(slugifyHostLabel('@Scope/Pkg_Name.v2')).toMatch(/^[a-z0-9-]+$/)
  })

  it('returns empty string when no alphanumeric run survives', () => {
    expect(slugifyHostLabel('@@@')).toBe('')
  })
})

describe('slugifyRelease re-export chain (REV-4)', () => {
  it('the public infra-kit/vite re-export resolves to the same behaviour', () => {
    expect(typeof slugFromEntry).toBe('function')
    expect(slugFromEntry('release/2.4')).toBe('2-4')
    expect(slugFromEntry('feature/HUL-123')).toBe('hul-123')
  })
})
