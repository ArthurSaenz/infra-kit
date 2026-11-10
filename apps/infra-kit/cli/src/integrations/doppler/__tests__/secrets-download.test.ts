import { describe, expect, it } from 'vitest'

import {
  DOPPLER_MAX_OUTPUT_BYTES,
  assertDopplerOutputSize,
  assertTokenScope,
  buildDopplerChildEnv,
  parseDopplerSecretsJson,
} from '../secrets-download'

describe('assertDopplerOutputSize', () => {
  it('accepts empty output (shape is validated separately)', () => {
    expect(() => {
      return assertDopplerOutputSize('')
    }).not.toThrow()
  })

  it('accepts typical-sized output', () => {
    expect(() => {
      return assertDopplerOutputSize('FOO=bar\n'.repeat(100))
    }).not.toThrow()
  })

  it('accepts output exactly at the cap', () => {
    const atCap = 'x'.repeat(DOPPLER_MAX_OUTPUT_BYTES)

    expect(() => {
      return assertDopplerOutputSize(atCap)
    }).not.toThrow()
  })

  it('rejects output one byte over the cap', () => {
    const overCap = 'x'.repeat(DOPPLER_MAX_OUTPUT_BYTES + 1)

    expect(() => {
      return assertDopplerOutputSize(overCap)
    }).toThrow(/unexpectedly large output/)
  })

  it('counts bytes not characters (multi-byte unicode)', () => {
    // "💥" is 4 bytes in UTF-8; N copies = 4N bytes. Pick N so bytes > cap but chars < cap.
    const chars = Math.ceil(DOPPLER_MAX_OUTPUT_BYTES / 4) + 1
    const multiByte = '💥'.repeat(chars)

    expect(multiByte.length).toBeLessThan(DOPPLER_MAX_OUTPUT_BYTES)
    expect(() => {
      return assertDopplerOutputSize(multiByte)
    }).toThrow(/unexpectedly large output/)
  })
})

describe('assertTokenScope', () => {
  it('accepts a payload whose DOPPLER_CONFIG matches the requested config', () => {
    expect(() => {
      return assertTokenScope(
        [
          ['DOPPLER_CONFIG', 'dev'],
          ['API_URL', 'x'],
        ],
        'dev',
      )
    }).not.toThrow()
  })

  it('throws on a mis-scoped token, naming BOTH configs', () => {
    expect(() => {
      return assertTokenScope([['DOPPLER_CONFIG', 'prod']], 'dev')
    }).toThrow(/"prod".*"dev"|"dev".*"prod"/su)
  })

  it('proceeds when DOPPLER_CONFIG is ABSENT — the CLI already refused a real mismatch', () => {
    expect(() => {
      return assertTokenScope([['API_URL', 'x']], 'dev')
    }).not.toThrow()
  })

  it('compares DOPPLER_CONFIG, never DOPPLER_ENVIRONMENT (config dev_personal lives in env dev)', () => {
    expect(() => {
      return assertTokenScope(
        [
          ['DOPPLER_CONFIG', 'dev_personal'],
          ['DOPPLER_ENVIRONMENT', 'dev'],
        ],
        'dev_personal',
      )
    }).not.toThrow()
  })
})

describe('buildDopplerChildEnv', () => {
  it('sets our token and scrubs every inherited Doppler var', () => {
    const childEnv = buildDopplerChildEnv('dp.st.dev.OURS', {
      PATH: '/usr/bin',
      DOPPLER_TOKEN: 'dp.st.INHERITED',
      DOPPLER_PROJECT: 'other-proj',
      DOPPLER_CONFIG: 'prod',
    })

    expect(childEnv.DOPPLER_TOKEN).toBe('dp.st.dev.OURS')
    expect(childEnv).not.toHaveProperty('DOPPLER_PROJECT')
    expect(childEnv).not.toHaveProperty('DOPPLER_CONFIG')
    expect(childEnv.PATH).toBe('/usr/bin')
  })

  it('does not mutate the base env it was given', () => {
    const base = { DOPPLER_CONFIG: 'prod' }

    buildDopplerChildEnv('dp.st.dev.OURS', base)

    expect(base.DOPPLER_CONFIG).toBe('prod')
  })
})

describe('parseDopplerSecretsJson', () => {
  it('parses a flat KEY:value object into ordered pairs (values returned raw)', () => {
    expect(parseDopplerSecretsJson('{"FOO":"bar","BAZ":"a$(x)"}')).toEqual([
      ['FOO', 'bar'],
      ['BAZ', 'a$(x)'],
    ])
  })

  // Regression: the message quoted the first 80 characters — which is where the first secret sits when
  // doppler prints a notice ahead of the JSON.
  it('never quotes the unparseable output, which may hold secret values', () => {
    const leaked = 'notice\n{"API_KEY":"sk-live-123"'

    expect(() => {
      return parseDopplerSecretsJson(leaked)
    }).toThrow(expect.objectContaining({ message: expect.not.stringContaining('sk-live-123') }))
  })

  it('throws on non-JSON output', () => {
    expect(() => {
      return parseDopplerSecretsJson('<html>nope</html>')
    }).toThrow(/non-JSON output/)
  })

  it('throws on a JSON array (wrong shape)', () => {
    expect(() => {
      return parseDopplerSecretsJson('["FOO","bar"]')
    }).toThrow(/unexpected JSON shape/)
  })

  it('throws on an empty object', () => {
    expect(() => {
      return parseDopplerSecretsJson('{}')
    }).toThrow(/empty output/)
  })

  it('throws on an invalid env var name', () => {
    expect(() => {
      return parseDopplerSecretsJson('{"1BAD":"x"}')
    }).toThrow(/invalid env var name/)
  })

  it('throws on a non-string value', () => {
    expect(() => {
      return parseDopplerSecretsJson('{"FOO":123}')
    }).toThrow(/non-string value/)
  })
})
