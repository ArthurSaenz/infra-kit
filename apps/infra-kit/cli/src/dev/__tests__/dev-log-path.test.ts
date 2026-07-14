import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { homeShorten } from 'src/dev/dev-server'
import { resolveLogDir } from 'src/dev/log-sink'

/**
 * Dev logs are now one file PER SERVICE under `<cacheRoot>/<INFRA_KIT_SESSION>/dev/<pid>/`, not a single
 * shared `logs.txt`. These tests pin the directory shape, the `no-session` fallback, and the
 * `~`-shortening used for the on-screen clickable label. `XDG_CACHE_HOME` is forced so `getCacheRoot()`
 * is deterministic across machines; the path is pure string-joining (no fs access), so this fake root
 * never needs to exist on disk.
 */
const FAKE_CACHE_HOME = '/fake-xdg-cache'

describe('dev-server — session log dir', () => {
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

  it('resolves under <cacheRoot>/<INFRA_KIT_SESSION>/dev/<pid> when a session is exported', () => {
    process.env.INFRA_KIT_SESSION = 'ab12cd34'

    expect(resolveLogDir()).toBe(`${FAKE_CACHE_HOME}/infra-kit/ab12cd34/dev/${process.pid}`)
  })

  it('falls back to a literal `no-session` folder when INFRA_KIT_SESSION is unset', () => {
    delete process.env.INFRA_KIT_SESSION

    expect(resolveLogDir()).toBe(`${FAKE_CACHE_HOME}/infra-kit/no-session/dev/${process.pid}`)
  })

  it('separates two processes that share one session id — the cmux case', () => {
    // `--cmux` spawns one `infra-kit dev` per pane and every pane INHERITS the same INFRA_KIT_SESSION.
    // Before the <pid> segment they all appended to one logs.txt, through two handles each.
    process.env.INFRA_KIT_SESSION = 'ab12cd34'

    const mine = resolveLogDir()
    const sibling = path.join(path.dirname(mine), '99999')

    expect(sibling).not.toBe(mine)
    expect(path.dirname(sibling)).toBe(path.dirname(mine))
  })
})

describe('dev-server — homeShorten', () => {
  it('replaces a leading home dir with `~`', () => {
    const home = os.homedir()

    expect(homeShorten(path.join(home, '.cache/infra-kit/ab12cd34/dev/123'))).toBe(
      '~/.cache/infra-kit/ab12cd34/dev/123',
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
