import { describe, expect, it } from 'vitest'

import { buildCmuxWorkspaceTitle } from 'src/integrations/cmux'

import { canonicalizeCmuxTitle } from '../canonicalize-cmux-title'

describe('canonicalizeCmuxTitle', () => {
  it('trims and collapses internal whitespace', () => {
    expect(canonicalizeCmuxTitle('  hulyo-monorepo   1.48.0  ')).toBe('hulyo-monorepo 1.48.0')
  })

  it('normalizes a v-prefixed semver token to its bare form', () => {
    expect(canonicalizeCmuxTitle('hulyo-monorepo v1.48.0')).toBe('hulyo-monorepo 1.48.0')
  })

  it('treats the v-prefixed and bare semver titles as the same key (cross-version drift)', () => {
    expect(canonicalizeCmuxTitle('hulyo-monorepo v1.48.0')).toBe(canonicalizeCmuxTitle('hulyo-monorepo 1.48.0'))
  })

  it('does NOT strip a leading v from a named release', () => {
    expect(canonicalizeCmuxTitle('hulyo-monorepo vega-redesign')).toBe('hulyo-monorepo vega-redesign')
  })

  it('leaves a non-release fallback title containing a slash untouched', () => {
    expect(canonicalizeCmuxTitle('hulyo-monorepo feature/foo')).toBe('hulyo-monorepo feature/foo')
  })

  it('does not corrupt a non-semver token that merely starts with v', () => {
    expect(canonicalizeCmuxTitle('v8-engine 1.2.3')).toBe('v8-engine 1.2.3')
    expect(canonicalizeCmuxTitle('appv1.2.3 main')).toBe('appv1.2.3 main')
  })

  it('is idempotent', () => {
    const once = canonicalizeCmuxTitle('hulyo-monorepo   v1.48.0 ')

    expect(canonicalizeCmuxTitle(once)).toBe(once)
  })

  // The invariant that generalizes the whole fix: the title a workspace is
  // created/renamed with must round-trip through canonicalization to the same
  // key the dedup/close check builds — regardless of which CLI version stored it.
  describe('round-trip invariant', () => {
    it('built title canonicalizes to a stable key for a versioned release', () => {
      const built = buildCmuxWorkspaceTitle({ repoName: 'hulyo-monorepo', branch: 'release/v1.48.0' })
      const storedByOldCli = 'hulyo-monorepo v1.48.0'

      expect(canonicalizeCmuxTitle(built)).toBe(canonicalizeCmuxTitle(storedByOldCli))
    })

    it('built title canonicalizes to a stable key for a named release', () => {
      const built = buildCmuxWorkspaceTitle({ repoName: 'hulyo-monorepo', branch: 'release/checkout-redesign' })

      expect(canonicalizeCmuxTitle(built)).toBe('hulyo-monorepo checkout-redesign')
    })
  })
})
