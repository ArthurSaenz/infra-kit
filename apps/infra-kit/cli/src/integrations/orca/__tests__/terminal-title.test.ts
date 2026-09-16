import { describe, expect, it } from 'vitest'

import { buildOrcaTerminalTitle } from '../terminal-title'

describe('buildOrcaTerminalTitle', () => {
  it.each([
    ['release/v1.48.0', '1.48.0'],
    ['release/checkout-redesign', 'checkout-redesign'],
    ['fix-post-script-ci-cd', 'fix-post-script-ci-cd'],
  ])('%s → %s', (branch, expected) => {
    expect(buildOrcaTerminalTitle({ branch })).toBe(expected)
  })
})
