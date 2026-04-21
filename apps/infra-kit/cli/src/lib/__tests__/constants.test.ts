import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  INFRA_KIT_SESSION_VAR,
  atomicWriteFileSync,
  getCacheRoot,
  getSessionCacheDir,
  parseVarNamesFromEnvFile,
} from '../constants'

const withTmpDir = (fn: (dir: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-test-'))

  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('parseVarNamesFromEnvFile', () => {
  it('returns empty array when file does not exist', () => {
    expect(parseVarNamesFromEnvFile('/nonexistent/path/env.sh')).toEqual([])
  })

  it('extracts var names from a standard env file', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'env.sh')

      fs.writeFileSync(file, 'FOO=bar\nBAZ=qux\n')
      expect(parseVarNamesFromEnvFile(file)).toEqual(['FOO', 'BAZ'])
    })
  })

  it('skips `set -a` / `set +a` shell directives', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'env.sh')

      fs.writeFileSync(file, 'set -a\nFOO=bar\nset +a\n')
      expect(parseVarNamesFromEnvFile(file)).toEqual(['FOO'])
    })
  })

  it('handles values that contain = characters', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'env.sh')

      fs.writeFileSync(file, 'CONNECTION_STRING=host=db;user=admin\nFOO=bar\n')
      expect(parseVarNamesFromEnvFile(file)).toEqual(['CONNECTION_STRING', 'FOO'])
    })
  })

  it('skips blank lines and lines that do not match KEY= prefix', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'env.sh')

      fs.writeFileSync(file, '\n# comment\nFOO=1\n\nunset BAR\nBAZ=2\n')
      expect(parseVarNamesFromEnvFile(file)).toEqual(['FOO', 'BAZ'])
    })
  })

  it('accepts numerics and underscores in the name but rejects names starting with digits', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'env.sh')

      fs.writeFileSync(file, 'API_KEY_2=a\n2FOO=b\n_INTERNAL=c\n')
      expect(parseVarNamesFromEnvFile(file)).toEqual(['API_KEY_2', '_INTERNAL'])
    })
  })
})

describe('getSessionCacheDir', () => {
  let originalSession: string | undefined
  let originalXdg: string | undefined

  beforeEach(() => {
    originalSession = process.env[INFRA_KIT_SESSION_VAR]
    originalXdg = process.env.XDG_CACHE_HOME
  })

  afterEach(() => {
    if (originalSession === undefined) {
      delete process.env[INFRA_KIT_SESSION_VAR]
    } else {
      process.env[INFRA_KIT_SESSION_VAR] = originalSession
    }

    if (originalXdg === undefined) {
      delete process.env.XDG_CACHE_HOME
    } else {
      process.env.XDG_CACHE_HOME = originalXdg
    }
  })

  it('throws with actionable message when INFRA_KIT_SESSION is unset', () => {
    delete process.env[INFRA_KIT_SESSION_VAR]
    expect(() => {
      return getSessionCacheDir()
    }).toThrow(/INFRA_KIT_SESSION/)
  })

  it('uses XDG_CACHE_HOME when set', () => {
    process.env[INFRA_KIT_SESSION_VAR] = 'abc123'
    process.env.XDG_CACHE_HOME = '/custom/cache'
    expect(getSessionCacheDir()).toBe('/custom/cache/infra-kit/abc123')
  })

  it('falls back to ~/.cache/infra-kit/<session> when XDG_CACHE_HOME is unset', () => {
    process.env[INFRA_KIT_SESSION_VAR] = 'xyz'
    delete process.env.XDG_CACHE_HOME
    expect(getSessionCacheDir()).toBe(path.join(os.homedir(), '.cache', 'infra-kit', 'xyz'))
  })

  it('getCacheRoot treats empty XDG_CACHE_HOME as unset', () => {
    process.env.XDG_CACHE_HOME = ''
    expect(getCacheRoot()).toBe(path.join(os.homedir(), '.cache', 'infra-kit'))
  })
})

describe('atomicWriteFileSync', () => {
  it('writes content with the requested mode', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'secret.sh')

      atomicWriteFileSync(file, 'HELLO=world\n', 0o600)
      expect(fs.readFileSync(file, 'utf-8')).toBe('HELLO=world\n')

      const mode = fs.statSync(file).mode & 0o777

      expect(mode).toBe(0o600)
    })
  })

  it('leaves no temp file behind after a successful write', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'secret.sh')

      atomicWriteFileSync(file, 'X=1\n', 0o600)

      const leftovers = fs.readdirSync(dir).filter((name) => {
        return name.includes('.tmp.')
      })

      expect(leftovers).toEqual([])
    })
  })

  it('overwrites an existing file', () => {
    withTmpDir((dir) => {
      const file = path.join(dir, 'secret.sh')

      fs.writeFileSync(file, 'OLD=1\n', { mode: 0o600 })
      atomicWriteFileSync(file, 'NEW=2\n', 0o600)
      expect(fs.readFileSync(file, 'utf-8')).toBe('NEW=2\n')
    })
  })
})
