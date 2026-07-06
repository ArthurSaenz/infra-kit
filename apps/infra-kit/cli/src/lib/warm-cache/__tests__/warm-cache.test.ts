import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ENV_CLEAR_FILE,
  ENV_LOAD_FILE,
  getProjectWarmCacheDir,
  getWarmCacheRoot,
  warmCacheKey,
} from 'src/lib/constants'

import {
  canonicalizeProjectRoot,
  evictStaleWarmCaches,
  invalidateProjectWarmCache,
  shouldWriteWarm,
  writeWarmCache,
} from '../warm-cache'

let tmp: string
const origXdg = process.env.XDG_CACHE_HOME

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-cache-test-'))
  process.env.XDG_CACHE_HOME = path.join(tmp, 'cache')
})

afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = origXdg
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('warmCacheKey — byte-identical to the zsh shasum contract', () => {
  it('is the plain hex sha256 of the verbatim dir string', () => {
    const dir = '/Users/x/projects/demo'

    expect(warmCacheKey(dir)).toBe(crypto.createHash('sha256').update(dir, 'utf8').digest('hex'))
  })

  it('matches `printf %s "$dir" | shasum -a 256 | cut -c1-64` (the shell side)', () => {
    const dir = '/Users/x/some/project path/with spaces'
    const shell = execFileSync('/bin/zsh', ['-c', `printf %s ${JSON.stringify(dir)} | shasum -a 256 | cut -c1-64`])
      .toString()
      .trim()

    expect(warmCacheKey(dir)).toBe(shell)
  })
})

describe('shouldWriteWarm — pure gate matrix', () => {
  const base = { autoLoaded: true, projectDir: '/p', canonicalProjectRoot: '/p' }

  it('writes when auto-loaded, dir passed, and realpath root === dir', () => {
    expect(shouldWriteWarm(base)).toBe(true)
  })

  it('skips a manual load', () => {
    expect(shouldWriteWarm({ ...base, autoLoaded: false })).toBe(false)
  })

  it('skips when no projectDir (cli-invocation trigger)', () => {
    expect(shouldWriteWarm({ ...base, projectDir: undefined })).toBe(false)
  })

  it('skips when non-git (empty canonical root — no sha256("") collapse)', () => {
    expect(shouldWriteWarm({ ...base, canonicalProjectRoot: '' })).toBe(false)
  })

  it('skips when the realpath root diverges from the shell dir (symlink/nested)', () => {
    expect(shouldWriteWarm({ ...base, canonicalProjectRoot: '/other' })).toBe(false)
  })
})

describe('canonicalizeProjectRoot', () => {
  it('returns "" for empty input', () => {
    expect(canonicalizeProjectRoot('')).toBe('')
  })

  it('returns "" for an unresolvable path', () => {
    expect(canonicalizeProjectRoot(path.join(tmp, 'does-not-exist'))).toBe('')
  })

  it('resolves symlinks to the physical path', () => {
    const real = path.join(tmp, 'real')
    const link = path.join(tmp, 'link')

    fs.mkdirSync(real)
    fs.symlinkSync(real, link)
    expect(canonicalizeProjectRoot(link)).toBe(fs.realpathSync(real))
  })
})

describe('writeWarmCache + evictStaleWarmCaches', () => {
  it('writes the warm file 0o600 and reads back the contents', () => {
    const dir = '/canon/project-a'

    writeWarmCache(dir, 'export A=1\n')
    const file = path.join(getProjectWarmCacheDir(dir), ENV_LOAD_FILE)

    expect(fs.readFileSync(file, 'utf8')).toBe('export A=1\n')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('dELETES a past-TTL other-project warm dir on the next write (criterion #12)', () => {
    const stale = '/canon/abandoned'

    writeWarmCache(stale, 'export OLD=1\n')
    const staleDir = getProjectWarmCacheDir(stale)
    // Backdate the stale file well past the TTL.
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000)

    fs.utimesSync(path.join(staleDir, ENV_LOAD_FILE), old, old)

    // A fresh write for a DIFFERENT project triggers the sweep.
    writeWarmCache('/canon/active', 'export NEW=1\n')
    evictStaleWarmCaches()

    expect(fs.existsSync(staleDir)).toBe(false)
    expect(fs.existsSync(getProjectWarmCacheDir('/canon/active'))).toBe(true)
  })

  it('keeps a fresh warm dir', () => {
    writeWarmCache('/canon/fresh', 'export F=1\n')
    evictStaleWarmCaches()
    expect(fs.existsSync(getProjectWarmCacheDir('/canon/fresh'))).toBe(true)
  })

  it('is a no-op when the warm root does not exist', () => {
    expect(() => {
      return evictStaleWarmCaches()
    }).not.toThrow()
    expect(fs.existsSync(getWarmCacheRoot())).toBe(false)
  })
})

describe('invalidateProjectWarmCache', () => {
  it('writes a clear-marker when a warm file exists (transient disable)', () => {
    const dir = '/canon/to-clear'

    writeWarmCache(dir, 'export A=1\n')
    invalidateProjectWarmCache(dir, false)
    expect(fs.existsSync(path.join(getProjectWarmCacheDir(dir), ENV_CLEAR_FILE))).toBe(true)
    // warm file itself remains (startup gate compares mtimes)
    expect(fs.existsSync(path.join(getProjectWarmCacheDir(dir), ENV_LOAD_FILE))).toBe(true)
  })

  it('does NOT create a dir/marker when there is no warm file', () => {
    invalidateProjectWarmCache('/canon/never-warmed', false)
    expect(fs.existsSync(getProjectWarmCacheDir('/canon/never-warmed'))).toBe(false)
  })

  it('purge deletes the whole warm dir', () => {
    const dir = '/canon/to-purge'

    writeWarmCache(dir, 'export A=1\n')
    invalidateProjectWarmCache(dir, true)
    expect(fs.existsSync(getProjectWarmCacheDir(dir))).toBe(false)
  })
})
