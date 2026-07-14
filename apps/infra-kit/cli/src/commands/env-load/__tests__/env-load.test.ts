import { describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'

import {
  DOPPLER_MAX_OUTPUT_BYTES,
  assertDopplerOutputSize,
  assertTokenScope,
  buildDopplerChildEnv,
  buildEnvLoadFileLines,
  parseDopplerSecretsJson,
  shellSingleQuote,
} from '../env-load'

vi.mock('src/lib/logger', () => {
  return { logger: { warn: vi.fn(), debug: vi.fn() } }
})

describe('shellSingleQuote', () => {
  it('wraps plain values in single quotes', () => {
    expect(shellSingleQuote('dev')).toBe("'dev'")
  })

  it('escapes embedded single quotes using the posix idiom', () => {
    expect(shellSingleQuote("it's")).toBe(String.raw`'it'\''s'`)
  })

  it('handles multiple single quotes', () => {
    expect(shellSingleQuote("a'b'c")).toBe(String.raw`'a'\''b'\''c'`)
  })

  it('wraps empty strings as empty single quotes', () => {
    expect(shellSingleQuote('')).toBe("''")
  })

  it('passes unicode through unchanged', () => {
    expect(shellSingleQuote('café')).toBe("'café'")
  })

  it('does not alter backslashes (single-quoted shell strings treat them literally)', () => {
    expect(shellSingleQuote(String.raw`a\b`)).toBe(String.raw`'a\b'`)
  })
})

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

describe('buildEnvLoadFileLines', () => {
  const args = {
    pairs: [
      ['A', '1'],
      ['B', '2'],
    ] as Array<[string, string]>,
    config: 'dev',
    project: 'proj',
    projectRoot: '/repo',
    loadedAt: '2026-01-01T00:00:00.000Z',
  }

  it('wraps the body in set -a / set +a and records config/project/projectRoot/loadedAt', () => {
    const lines = buildEnvLoadFileLines({ ...args, autoLoaded: false })

    expect(lines[0]).toBe('set -a')
    expect(lines.at(-1)).toBe('set +a')
    expect(lines).toContain("A='1'")
    expect(lines).toContain("B='2'")
    expect(lines).toContain("INFRA_KIT_ENV='dev'")
    expect(lines).toContain("INFRA_KIT_ENV_CONFIG='dev'")
    expect(lines).toContain("INFRA_KIT_ENV_PROJECT='proj'")
    expect(lines).toContain("INFRA_KIT_ENV_PROJECT_ROOT='/repo'")
    expect(lines).toContain("INFRA_KIT_ENV_LOADED_AT='2026-01-01T00:00:00.000Z'")
  })

  it('exports the purpose-named INFRA_KIT_ENV handle, single-quoted', () => {
    const lines = buildEnvLoadFileLines({ ...args, config: 'arthur', autoLoaded: false })

    expect(lines).toContain("INFRA_KIT_ENV='arthur'")
  })

  it('writes the AUTOLOADED marker only when autoLoaded is true', () => {
    const lines = buildEnvLoadFileLines({ ...args, autoLoaded: true })

    expect(lines).toContain("INFRA_KIT_ENV_AUTOLOADED='1'")
    expect(lines).not.toContain('unset INFRA_KIT_ENV_AUTOLOADED')
  })

  it('drops the marker and lifts the clear sentinel on a manual load (autoLoaded false)', () => {
    const lines = buildEnvLoadFileLines({ ...args, autoLoaded: false })

    expect(lines).toContain('unset INFRA_KIT_ENV_AUTOLOADED')
    expect(lines).toContain('unset INFRA_KIT_ENV_CLEARED')
    expect(lines).not.toContain("INFRA_KIT_ENV_AUTOLOADED='1'")
  })
})

describe('buildEnvLoadFileLines — injection neutralization (single-quoting)', () => {
  const baseArgs = {
    config: 'dev',
    project: 'proj',
    projectRoot: '/repo',
    loadedAt: '2026-01-01T00:00:00.000Z',
    autoLoaded: false as const,
  }

  it('single-quotes shell-active values so nothing expands or executes on source', () => {
    const pairs: Array<[string, string]> = [
      ['CMD', 'a$(id)b'],
      ['VAR', 'x$HOME'],
      ['TICK', '`whoami`'],
      ['Q', "it's"],
      ['NL', 'line1\nline2'],
    ]

    const lines = buildEnvLoadFileLines({ ...baseArgs, pairs })

    // Each value line is exactly KEY=<posix-single-quoted value>.
    expect(lines).toContain("CMD='a$(id)b'")
    expect(lines).toContain("VAR='x$HOME'")
    expect(lines).toContain("TICK='`whoami`'")
    expect(lines).toContain(String.raw`Q='it'\''s'`)
    // The newline stays literal inside the single quotes.
    expect(lines).toContain("NL='line1\nline2'")

    // The load-bearing guarantee: no emitted value line carries an unescaped
    // command substitution, backtick, or a double-quote-wrapped value.
    const valueLines = lines.filter((line) => {
      return /^(?:CMD|VAR|TICK|Q|NL)=/.test(line)
    })

    for (const line of valueLines) {
      const value = line.slice(line.indexOf('=') + 1)

      expect(value.startsWith("'")).toBe(true)
      expect(value.endsWith("'")).toBe(true)
      expect(value).not.toMatch(/^"/)
    }
  })
})

describe('buildEnvLoadFileLines — credential filtering', () => {
  const baseArgs = {
    config: 'dev',
    project: 'proj',
    projectRoot: '/repo',
    loadedAt: '2026-01-01T00:00:00.000Z',
    autoLoaded: false as const,
  }

  const TOKEN_LITERAL = 'dp.st.dev.NEVER_IN_A_SOURCED_FILE'

  // The ONLY test in this file that feeds credential-bearing pairs, so the module-scoped
  // "warned once" flag is untouched by everything else and the count below is meaningful.
  it('drops DOPPLER_TOKEN / INFRA_KIT_ENV_TOKEN, keeps the scope evidence, and warns exactly once', () => {
    const pairs: Array<[string, string]> = [
      ['DOPPLER_TOKEN', TOKEN_LITERAL],
      ['INFRA_KIT_ENV_TOKEN', TOKEN_LITERAL],
      ['DOPPLER_CONFIG', 'dev'],
      ['DOPPLER_PROJECT', 'proj'],
      ['DOPPLER_ENVIRONMENT', 'dev'],
      ['API_URL', 'https://api.example.com'],
    ]

    const first = buildEnvLoadFileLines({ ...baseArgs, pairs })
    const second = buildEnvLoadFileLines({ ...baseArgs, pairs })

    for (const lines of [first, second]) {
      const file = lines.join('\n')

      expect(file).not.toContain(TOKEN_LITERAL)
      expect(file).not.toContain('DOPPLER_TOKEN=')
      expect(file).not.toContain('INFRA_KIT_ENV_TOKEN=')

      // The scope evidence assertTokenScope and doctor read back — not credentials.
      expect(lines).toContain("DOPPLER_CONFIG='dev'")
      expect(lines).toContain("DOPPLER_PROJECT='proj'")
      expect(lines).toContain("API_URL='https://api.example.com'")
    }

    expect(logger.warn).toHaveBeenCalledOnce()

    const warning = vi.mocked(logger.warn).mock.calls[0]![0] as string

    expect(warning).toContain('DOPPLER_TOKEN')
    expect(warning).not.toContain(TOKEN_LITERAL)
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
