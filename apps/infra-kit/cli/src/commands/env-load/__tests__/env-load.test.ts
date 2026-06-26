import { describe, expect, it } from 'vitest'

import {
  DOPPLER_MAX_OUTPUT_BYTES,
  assertDopplerOutputSize,
  assertValidEnvContent,
  buildEnvLoadFileLines,
  shellSingleQuote,
} from '../env-load'

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

describe('assertValidEnvContent', () => {
  it('throws on empty content', () => {
    expect(() => {
      return assertValidEnvContent('')
    }).toThrow(/empty output/)
  })

  it('throws on whitespace-only content', () => {
    expect(() => {
      return assertValidEnvContent('   \n\n  ')
    }).toThrow(/empty output/)
  })

  it('accepts a single KEY=value line', () => {
    expect(() => {
      return assertValidEnvContent('FOO=bar')
    }).not.toThrow()
  })

  it('accepts multiple KEY=value lines', () => {
    expect(() => {
      return assertValidEnvContent('FOO=bar\nBAZ=qux\nQUUX=123')
    }).not.toThrow()
  })

  it('ignores `set -a` / `set +a` directives', () => {
    expect(() => {
      return assertValidEnvContent('set -a\nFOO=bar\nset +a')
    }).not.toThrow()
  })

  it('ignores blank lines between KEY=value lines', () => {
    expect(() => {
      return assertValidEnvContent('FOO=bar\n\nBAZ=qux')
    }).not.toThrow()
  })

  it('throws when first non-blank line is not KEY=value', () => {
    expect(() => {
      return assertValidEnvContent('<html>error</html>\nFOO=bar')
    }).toThrow(/unexpected output/)
  })

  it('throws when a later line is garbage (not only first-line validation)', () => {
    expect(() => {
      return assertValidEnvContent('FOO=bar\n<html>error</html>')
    }).toThrow(/unexpected output/)
  })

  it('throws when a line looks like a shell command rather than an assignment', () => {
    expect(() => {
      return assertValidEnvContent('FOO=bar\nunset BAR')
    }).toThrow(/unexpected output/)
  })

  it('accepts values containing = characters (connection strings)', () => {
    expect(() => {
      return assertValidEnvContent('DB_URL=host=db;user=admin\nFOO=bar')
    }).not.toThrow()
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
  const args = { envContent: 'A=1\nB=2', config: 'dev', project: 'proj', loadedAt: '2026-01-01T00:00:00.000Z' }

  it('wraps the body in set -a / set +a and records config/project/loadedAt', () => {
    const lines = buildEnvLoadFileLines({ ...args, autoLoaded: false })

    expect(lines[0]).toBe('set -a')
    expect(lines.at(-1)).toBe('set +a')
    expect(lines).toContain("INFRA_KIT_ENV_CONFIG='dev'")
    expect(lines).toContain("INFRA_KIT_ENV_PROJECT='proj'")
    expect(lines).toContain("INFRA_KIT_ENV_LOADED_AT='2026-01-01T00:00:00.000Z'")
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
