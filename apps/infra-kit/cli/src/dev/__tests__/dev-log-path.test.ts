import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { homeShorten, resolveLogFilePath } from 'src/dev/dev-server'

/**
 * The dev-server log now lives under infra-kit's own per-terminal session cache dir
 * (`<cacheRoot>/<INFRA_KIT_SESSION>/logs.txt`), reusing the same id that keys `env-load.sh`. These
 * tests pin the path shape + the `no-session` fallback, and the `~`-shortening used for the on-screen
 * clickable label. `XDG_CACHE_HOME` is forced so `getCacheRoot()` is deterministic across machines;
 * the path is pure string-joining (no fs access), so this fake root never needs to exist on disk.
 */
const FAKE_CACHE_HOME = '/fake-xdg-cache'

describe('dev-server — session log path', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME
    saved.INFRA_KIT_SESSION = process.env.INFRA_KIT_SESSION
    process.env.XDG_CACHE_HOME = FAKE_CACHE_HOME
  })

  afterEach(() => {
    for (const key of ['XDG_CACHE_HOME', 'INFRA_KIT_SESSION'] as const) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('resolves under <cacheRoot>/<INFRA_KIT_SESSION>/logs.txt when a session is exported', () => {
    process.env.INFRA_KIT_SESSION = 'ab12cd34'

    expect(resolveLogFilePath()).toBe(`${FAKE_CACHE_HOME}/infra-kit/ab12cd34/logs.txt`)
  })

  it('falls back to a literal `no-session` folder when INFRA_KIT_SESSION is unset', () => {
    delete process.env.INFRA_KIT_SESSION

    expect(resolveLogFilePath()).toBe(`${FAKE_CACHE_HOME}/infra-kit/no-session/logs.txt`)
  })
})

describe('dev-server — homeShorten', () => {
  it('replaces a leading home dir with `~`', () => {
    const home = os.homedir()

    expect(homeShorten(path.join(home, '.cache/infra-kit/ab12cd34/logs.txt'))).toBe(
      '~/.cache/infra-kit/ab12cd34/logs.txt',
    )
    expect(homeShorten(home)).toBe('~')
  })

  it('leaves a path outside the home dir untouched', () => {
    expect(homeShorten('/var/log/other.txt')).toBe('/var/log/other.txt')
  })

  it('does not shorten a sibling dir that merely shares the home prefix (separator boundary)', () => {
    // `/Users/arthurX/...` must not match a home of `/Users/arthur` — the guard requires a path.sep.
    const sibling = `${os.homedir()}X${path.sep}foo.txt`

    expect(homeShorten(sibling)).toBe(sibling)
  })
})
