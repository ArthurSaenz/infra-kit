import { describe, expect, it } from 'vitest'

import { redactToken } from '../redact'

/**
 * Shaped like a real Doppler service token (that shape is the point), but a fixture, not a credential.
 * Assembled rather than written as one literal so the secret scanner does not have to guess: there is
 * no credential here to leak, and a `// eslint-disable` would suppress the rule for a real one too.
 */
const FAKE_TOKEN_FIXTURE = ['dp', 'st', 'dev', 'NOT_A_REAL_TOKEN_fixture_012345'].join('.')

describe('redactToken', () => {
  it('reveals at most the last 4 characters', () => {
    expect(redactToken(FAKE_TOKEN_FIXTURE)).toBe('****2345')
  })

  /**
   * The property, not the example: whatever the input, the output must not contain any run of the
   * token longer than its last 4 chars. This is what would catch an "improved" implementation that
   * kept a prefix ("dp.st.dev.…2345") for readability — which would hand over the token's project
   * scope, and, on a short token, most of the token.
   */
  it('never emits more of the token than its last 4 characters', () => {
    for (const candidate of [FAKE_TOKEN_FIXTURE, 'dp.st.abc', 'x'.repeat(64), 'short', 'abcdefgh']) {
      const redacted = redactToken(candidate)
      const suffix = candidate.slice(-4)

      const leaked = redacted.replaceAll(suffix, '').replaceAll('*', '')

      expect(leaked, `redactToken(${candidate}) leaked "${leaked}"`).toBe('')
    }
  })

  // A redaction helper that throws is a redaction helper someone wraps in a try/catch whose fallback
  // prints the raw value. It must be total.
  it('handles a short or malformed input without throwing, and reveals nothing', () => {
    expect(redactToken('')).toBe('****')
    expect(redactToken('abc')).toBe('****')
    // A token too short for a suffix reveals NOTHING — showing the last 4 of a 6-char string is most of it.
    expect(redactToken('abcdef')).toBe('****')
    expect(redactToken(undefined as unknown as string)).toBe('****')
    expect(redactToken(null as unknown as string)).toBe('****')
  })
})
