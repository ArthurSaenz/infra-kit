import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ENV_FILE_OVERRIDE_VAR,
  NO_SESSION,
  readListedVars,
  readUnlistedNames,
  resolveEnvFilePath,
  resolveSessionId,
} from '../env-vars'
import { envFileBody, quoteEnvValue } from './helpers/env-file'

const GRAFANA_NAMES = ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN']

const withEnvFile = (lines: readonly string[], fn: (file: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-env-'))

  try {
    const file = path.join(dir, 'env-load.sh')

    fs.writeFileSync(file, envFileBody(lines))
    fn(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('readUnlistedNames — isolation from the rest of the env file', () => {
  it('returns every name that is not listed, and only those', () => {
    withEnvFile(
      [
        `AWS_SECRET_ACCESS_KEY=${quoteEnvValue('aws-secret')}`,
        `GRAFANA_URL=${quoteEnvValue('https://real.grafana.example')}`,
        `GRAFANA_SERVICE_ACCOUNT_TOKEN=${quoteEnvValue('the-real-token')}`,
        `HULYO_MONGODB_CONNECTION=${quoteEnvValue('mongodb://user:pw@host')}`,
        `MY_GRAFANA_TOKEN=${quoteEnvValue('not-listed')}`,
      ],
      (file) => {
        expect(readUnlistedNames(GRAFANA_NAMES, file).sort()).toEqual([
          'AWS_SECRET_ACCESS_KEY',
          'HULYO_MONGODB_CONNECTION',
          'MY_GRAFANA_TOKEN',
        ])
      },
    )
  })
})

describe('readListedVars', () => {
  /**
   * The regression the prototype's `/^([A-Z_][A-Z0-9_]*)='(.*)'$/` could not survive. The names in
   * this fixture are data: it tests the PARSER, and stays verbatim through the rename.
   */
  it('is not hijacked by assignment-looking lines inside a multiline secret that sorts after the listed names', () => {
    // Doppler emits keys sorted, so any *_KEY/_CERT/_JSON past "G" lands below the real
    // GRAFANA_* lines — and with a naive per-line regex it WINS, redirecting the upstream at a
    // host chosen by whoever can write that unrelated secret.
    const poisoned = [
      '-----BEGIN PRIVATE KEY-----',
      `GRAFANA_URL=${quoteEnvValue('https://attacker.example')}`,
      `GRAFANA_SERVICE_ACCOUNT_TOKEN=${quoteEnvValue('attacker-controlled')}`,
      '-----END PRIVATE KEY-----',
    ].join('\n')

    withEnvFile(
      [
        `GRAFANA_URL=${quoteEnvValue('https://real.grafana.example')}`,
        `GRAFANA_SERVICE_ACCOUNT_TOKEN=${quoteEnvValue('the-real-token')}`,
        `ZULU_PRIVATE_KEY=${quoteEnvValue(poisoned)}`,
      ],
      (file) => {
        expect(readListedVars(GRAFANA_NAMES, file)).toEqual({
          GRAFANA_URL: 'https://real.grafana.example',
          GRAFANA_SERVICE_ACCOUNT_TOKEN: 'the-real-token',
        })
      },
    )
  })

  it('round-trips a value containing literal single quotes', () => {
    withEnvFile([`A=${quoteEnvValue("it's")}`, `B=${quoteEnvValue("a'b'c")}`], (file) => {
      expect(readListedVars(['A', 'B'], file)).toEqual({ A: "it's", B: "a'b'c" })
    })
  })

  it('does not leave a CR on values read from a CRLF file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-crlf-'))

    try {
      const file = path.join(tmp, 'env-load.sh')

      // A token ending in \r looks correct in every diff and fails every request.
      fs.writeFileSync(
        file,
        `set -a\r\nA=${quoteEnvValue('https://a.example')}\r\nB=${quoteEnvValue('tok')}\r\nset +a\r\n`,
      )

      expect(readListedVars(['A', 'B'], file)).toEqual({ A: 'https://a.example', B: 'tok' })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('builds the record in the LISTED order, whatever order the file has — the JSON is the respawn key', () => {
    withEnvFile([`B=${quoteEnvValue('2')}`, `A=${quoteEnvValue('1')}`], (file) => {
      expect(Object.keys(readListedVars(['A', 'B'], file) ?? {})).toEqual(['A', 'B'])
      expect(JSON.stringify(readListedVars(['A', 'B'], file))).toBe(JSON.stringify({ A: '1', B: '2' }))
    })
  })

  describe('missing halves are normal, never errors', () => {
    it.each([
      ['absent file', undefined],
      ['empty file', []],
      ['first name only', ['A=%'] as const],
      ['second name only', ['B=%'] as const],
    ])('returns null for %s', (_label, lines) => {
      vi.stubEnv('A', '')
      vi.stubEnv('B', '')

      if (lines === undefined) {
        expect(readListedVars(['A', 'B'], '/nonexistent/path/env-load.sh')).toBeNull()

        return
      }

      withEnvFile(
        lines.map((line) => {
          return line.replace('%', quoteEnvValue('x'))
        }),
        (file) => {
          expect(readListedVars(['A', 'B'], file)).toBeNull()
        },
      )
    })

    it('does not throw when the path is a directory', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-dir-'))

      try {
        expect(() => {
          return readListedVars(['A'], dir)
        }).not.toThrow()
        expect(readUnlistedNames(['A'], dir)).toEqual([])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('precedence', () => {
    it('prefers the file over process.env, per name', () => {
      vi.stubEnv('A', 'from-process-env')
      vi.stubEnv('B', 'env-b')

      withEnvFile([`A=${quoteEnvValue('from-file')}`], (file) => {
        expect(readListedVars(['A', 'B'], file)).toEqual({ A: 'from-file', B: 'env-b' })
      })
    })

    it('falls back to process.env when the file has neither', () => {
      vi.stubEnv('A', 'env-a')
      vi.stubEnv('B', 'env-b')

      withEnvFile([`AWS_SECRET_ACCESS_KEY=${quoteEnvValue('aws')}`], (file) => {
        expect(readListedVars(['A', 'B'], file)).toEqual({ A: 'env-a', B: 'env-b' })
      })
    })
  })
})

describe('resolveEnvFilePath', () => {
  const withCacheRoot = (fn: (root: string) => void): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-mcp-xdg-'))

    try {
      fn(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  it('honours XDG_CACHE_HOME', () => {
    withCacheRoot((root) => {
      vi.stubEnv('XDG_CACHE_HOME', root)
      vi.stubEnv('INFRA_KIT_SESSION', 'abc12345')
      vi.stubEnv(ENV_FILE_OVERRIDE_VAR, '')

      expect(resolveEnvFilePath()).toBe(path.join(root, 'infra-kit', 'abc12345', 'env-load.sh'))
    })
  })

  it('falls back to ~/.cache when XDG_CACHE_HOME is unset', () => {
    vi.stubEnv('XDG_CACHE_HOME', '')
    vi.stubEnv('INFRA_KIT_SESSION', 'abc12345')
    vi.stubEnv(ENV_FILE_OVERRIDE_VAR, '')

    expect(resolveEnvFilePath()).toBe(path.join(os.homedir(), '.cache', 'infra-kit', 'abc12345', 'env-load.sh'))
  })

  it('never throws when INFRA_KIT_SESSION is unset — it degrades to the no-session dir', () => {
    withCacheRoot((root) => {
      vi.stubEnv('XDG_CACHE_HOME', root)
      vi.stubEnv('INFRA_KIT_SESSION', '')
      vi.stubEnv(ENV_FILE_OVERRIDE_VAR, '')

      expect(resolveSessionId()).toBe(NO_SESSION)
      expect(resolveEnvFilePath()).toBe(path.join(root, 'infra-kit', NO_SESSION, 'env-load.sh'))
    })
  })

  it('lets the override win outright', () => {
    withCacheRoot((root) => {
      const override = path.join(root, 'hand-written.sh')

      vi.stubEnv(ENV_FILE_OVERRIDE_VAR, override)

      expect(resolveEnvFilePath()).toBe(override)
    })
  })
})
