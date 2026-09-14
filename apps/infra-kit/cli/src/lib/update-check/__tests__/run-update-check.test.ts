import type { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'

import { PLUGIN_UPDATE_ARGV } from 'src/lib/plugin-pointer/claude-cli'
import type { PluginInstallation } from 'src/lib/plugin-pointer/install-state'

import { PARENT_WAIT_TIMEOUT_MS, pluginStepWithheld, runUpdateCheck } from '../run-update-check'
import type { RunUpdateCheckDeps, UpdateCheckOutcome } from '../run-update-check'
import type { UpdateCache } from '../update-cache'
import { PLUGIN_UPDATE_BUDGET_MS, PLUGIN_UPDATE_RUN_TIMEOUT_MS } from '../update-plugin'

const GLOBAL_NPM_CLI = '/usr/local/lib/node_modules/infra-kit/dist/cli.js'
const HOMEBREW_CLI = '/opt/homebrew/Cellar/infra-kit/0.1.130/lib/node_modules/infra-kit/dist/cli.js'

const NOW = 1_770_000_000_000

const okSpawn = (): ReturnType<typeof spawnSync> => {
  return { status: 0, signal: null, error: undefined } as unknown as ReturnType<typeof spawnSync>
}

const harness = (overrides: Partial<RunUpdateCheckDeps> = {}) => {
  const writes: UpdateCache[] = []
  const spawnMock = vi.fn(okSpawn)
  const pluginSpawnMock = vi.fn(okSpawn)
  const runClaudeMock = vi.fn(() => {
    return { ok: true }
  })
  let released = 0

  const deps: RunUpdateCheckDeps = {
    selfRealPath: GLOBAL_NPM_CLI,
    // Agrees with the `/usr/local` prefix detectInstallManager derives from GLOBAL_NPM_CLI's own path.
    env: { npm_config_prefix: '/usr/local' },
    // A parent that has already exited: the install may proceed. Omitting it is the fail-safe path.
    parentPid: 4242,
    nowMs: NOW,
    clock: () => {
      return NOW
    },
    fetchLatest: async () => {
      return '0.1.131'
    },
    writeCache: (cache) => {
      return writes.push(cache)
    },
    isProcessAlive: () => {
      return false
    },
    sleep: async () => {
      return undefined
    },
    // Injected so no unit test ever shells out to the real `npm root -g`.
    lazyNpmRoot: () => {
      return undefined
    },
    // Injected so no unit test takes a real lock in the developer's actual cache root.
    acquireLock: () => {
      return () => {
        released += 1
      }
    },
    spawnSync: spawnMock as unknown as typeof spawnSync,
    // The probe agrees with `fetchLatest` by default: the install did what it claimed.
    installedVersion: () => {
      return '0.1.131'
    },
    // The plugin step's seams, all injected so no unit test spawns a real `claude` or reads the
    // developer's own `installed_plugins.json`. No records by default: the step reports `skipped`.
    runClaude: runClaudeMock,
    spawnPluginUpdate: pluginSpawnMock as unknown as typeof spawnSync,
    listPluginInstallations: () => {
      return []
    },
    pathExists: () => {
      return true
    },
    ...overrides,
  }

  return {
    deps,
    writes,
    /** The locked function's own writes — the plugin stamp (the one write carrying `plugin`) excluded. */
    cliWrites: (): UpdateCache[] => {
      return writes.filter((cache) => {
        return cache.plugin === undefined
      })
    },
    spawnMock,
    pluginSpawnMock,
    runClaudeMock,
    releasedCount: () => {
      return released
    },
  }
}

describe('runUpdateCheck single-flight lock', () => {
  it('stands down without fetching or writing when another worker holds the lock', async () => {
    const { deps, writes, spawnMock, pluginSpawnMock, runClaudeMock } = harness({
      acquireLock: () => {
        return null
      },
      fetchLatest: async () => {
        throw new Error('must not fetch while another worker owns the lock')
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('already-running')

    expect(writes).toEqual([])
    expect(spawnMock).not.toHaveBeenCalled()
    // The plugin step is behind the same lock: no probe, no update, no stamp.
    expect(runClaudeMock).not.toHaveBeenCalled()
    expect(pluginSpawnMock).not.toHaveBeenCalled()
  })

  it('releases the lock on the happy path', async () => {
    const { deps, releasedCount } = harness()

    await runUpdateCheck('0.1.130', deps)

    expect(releasedCount()).toBe(1)
  })

  it('releases the lock even when the install throws', async () => {
    // A held lock outlives the process only until LOCK_STALE_MS; still, leaking it would stall updates.
    const { deps, releasedCount } = harness({
      spawnSync: (() => {
        throw new Error('spawn exploded')
      }) as unknown as typeof spawnSync,
    })

    await expect(runUpdateCheck('0.1.130', deps)).rejects.toThrow('spawn exploded')
    expect(releasedCount()).toBe(1)
  })
})

describe('runUpdateCheck', () => {
  it('installs silently when a newer version exists and the manager is self-spawnable', async () => {
    const { deps, spawnMock } = harness()

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('installed')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [bin, args, options] = spawnMock.mock.calls[0] as unknown as [string, string[], { stdio: string }]

    // `--prefix` is derived from GLOBAL_NPM_CLI's own path, so the install lands in the tree we run from
    // rather than wherever the `npm` on PATH happens to default to. The spec is the version the worker
    // fetched, never `@latest`: pnpm resolves a tag from its own metadata cache without revalidating, so the
    // tag form reinstalled the stale version, exited 0, and was recorded as `installed`.
    expect([bin, ...args]).toEqual(['npm', 'install', '-g', '--prefix', '/usr/local', 'infra-kit@0.1.131'])
    // Silent: a detached child has nowhere to write, and stdout must never carry chatter.
    expect(options.stdio).toBe('ignore')
  })

  it('clears latestVersion after a successful install so the next run does not re-notify', async () => {
    const { deps, cliWrites } = harness()

    await runUpdateCheck('0.1.130', deps)

    expect(cliWrites().at(-1)).toEqual({
      lastCheckMs: NOW,
      latestVersion: null,
      updateCommand: null,
      outcome: 'installed',
    })
  })

  it('self-spawns for a plain `npm i -g` install, whose shell has no npm_config_prefix', async () => {
    // REGRESSION: every matcher used to miss for the most common install method — the shell of a user who
    // ran `npm i -g` months ago carries no npm_config_prefix — and detection reported `unknown`, degrading
    // the silent auto-install to a mere notice.
    const { deps, spawnMock } = harness({ env: {} })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('installed')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('installs into OUR prefix when the npm on PATH belongs to a different node', async () => {
    // REGRESSION (the reported one): `npm root -g` answers for whichever npm is first on PATH. When that
    // is a pnpm/nvm-managed node — or when the node that installed us is simply gone — the root it names
    // does not contain us, so detection said `unknown` and the user got the same notice on every command.
    // Worse, the printed `npm install -g` would have installed into that OTHER root, leaving the binary on
    // PATH untouched. The prefix must come from our own path.
    const { deps, spawnMock } = harness({
      env: {},
      lazyNpmRoot: () => {
        return '/Users/x/Library/pnpm/nodejs/24.21.0/lib/node_modules'
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('installed')

    const [bin, args] = spawnMock.mock.calls[0] as unknown as [string, string[]]

    expect([bin, ...args]).toEqual(['npm', 'install', '-g', '--prefix', '/usr/local', 'infra-kit@0.1.131'])
  })

  it('persists lastCheckMs even when the fetch FAILS, so an offline user is not a fetch-storm', async () => {
    // The whole point of the throttle: if lastCheckMs only landed on success, every command an
    // offline user runs would spawn another doomed detached child.
    const { deps, cliWrites, spawnMock } = harness({
      fetchLatest: async () => {
        return null
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('fetch-failed')

    expect(cliWrites()).toEqual([
      { lastCheckMs: NOW, latestVersion: null, updateCommand: null, outcome: 'fetch-failed' },
    ])
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does nothing when already up to date', async () => {
    const { deps, spawnMock } = harness({
      fetchLatest: async () => {
        return '0.1.130'
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('up-to-date')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('never treats a numerically-older patch as an update (0.1.9 is not newer than 0.1.130)', async () => {
    const { deps, spawnMock } = harness({
      fetchLatest: async () => {
        return '0.1.9'
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('up-to-date')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses to install a Homebrew-owned CLI, recording the version for the parent to announce', async () => {
    const { deps, cliWrites, spawnMock } = harness({ selfRealPath: HOMEBREW_CLI, env: {} })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('cannot-self-spawn')

    expect(spawnMock).not.toHaveBeenCalled()
    // The command is recorded so the PARENT can print it without paying for detection on startup.
    expect(cliWrites().at(-1)).toEqual({
      lastCheckMs: NOW,
      latestVersion: '0.1.131',
      updateCommand: ['brew', 'upgrade', 'infra-kit'],
      outcome: 'cannot-self-spawn',
    })
  })

  it('refuses to install from an unrecognized location rather than guessing', async () => {
    const { deps, spawnMock } = harness({ selfRealPath: '/opt/weird/infra-kit/dist/cli.js', env: {} })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('cannot-self-spawn')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('waits for the parent to exit before overwriting dist/', async () => {
    // esbuild `splitting: true` means dist/cli.js lazily imports sibling chunks. Installing over dist/
    // while the parent is mid-command deletes a chunk it has not imported yet.
    const aliveChecks: boolean[] = [true, true, false]
    let index = 0
    const order: string[] = []

    const { deps, spawnMock } = harness({
      parentPid: 4242,
      isProcessAlive: () => {
        const alive = aliveChecks[index] ?? false

        index += 1
        order.push(`alive:${String(alive)}`)

        return alive
      },
      sleep: async () => {
        order.push('sleep')
      },
      spawnSync: (() => {
        order.push('install')

        return okSpawn()
      }) as unknown as typeof spawnSync,
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('installed')

    // The install must come strictly after the parent was observed gone.
    expect(order).toEqual(['alive:true', 'sleep', 'alive:true', 'sleep', 'alive:false', 'install'])
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('gives up instead of installing when a long-lived parent outlasts the wait timeout', async () => {
    // `infra-kit dev` runs for hours; the child must not linger, and must never install underneath it.
    let clockMs = NOW
    const { deps, spawnMock } = harness({
      parentPid: 4242,
      isProcessAlive: () => {
        return true
      },
      clock: () => {
        return clockMs
      },
      sleep: async () => {
        clockMs += PARENT_WAIT_TIMEOUT_MS / 2
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('parent-still-running')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses to install when no parentPid was passed, rather than clobbering a live dist/', async () => {
    // Fail SAFE: with no parent to outlive, we cannot know that some CLI is not mid-command, lazily
    // importing a chunk out of the dist/ we would replace.
    const { deps, spawnMock } = harness({ parentPid: undefined })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('parent-unknown')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('reports install-failed on a non-zero exit without throwing', async () => {
    const { deps } = harness({
      parentPid: 4242,
      spawnSync: (() => {
        return { status: 1, signal: null, error: undefined }
      }) as unknown as typeof spawnSync,
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('install-failed')
  })

  // `pnpm add -g infra-kit@latest` did exactly this: resolved the tag from a stale metadata cache,
  // reinstalled the old version, exited 0. Trusting the exit code recorded `installed` and cleared the
  // notice, so the user stayed on the old binary with nothing telling them.
  it('records install-stale with the command when the install exits 0 but the PATH binary still reports the old version', async () => {
    const { deps, cliWrites } = harness({
      installedVersion: () => {
        return '0.1.130'
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('install-stale')

    expect(cliWrites().at(-1)).toEqual({
      lastCheckMs: NOW,
      latestVersion: '0.1.131',
      updateCommand: ['npm', 'install', '-g', '--prefix', '/usr/local', 'infra-kit@0.1.131'],
      outcome: 'install-stale',
    })
  })

  it('treats an unreadable post-install version as stale, never as installed', async () => {
    const { deps, cliWrites } = harness({
      installedVersion: () => {
        return null
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('install-stale')
    expect(cliWrites().at(-1)?.latestVersion).toBe('0.1.131')
  })

  it('does not probe the installed version when the install itself failed', async () => {
    const installedVersion = vi.fn(() => {
      return '0.1.131'
    })
    const { deps } = harness({
      installedVersion,
      spawnSync: (() => {
        return { status: 1, signal: null, error: undefined }
      }) as unknown as typeof spawnSync,
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('install-failed')
    expect(installedVersion).not.toHaveBeenCalled()
  })

  it('records the manual command when the silent install FAILS, so it cannot fail invisibly forever', async () => {
    // e.g. EACCES on a root-owned global dir. Without this the user is told nothing, ever.
    const { deps, cliWrites } = harness({
      parentPid: 4242,
      spawnSync: (() => {
        return { status: 1, signal: null, error: undefined }
      }) as unknown as typeof spawnSync,
    })

    await runUpdateCheck('0.1.130', deps)

    expect(cliWrites().at(-1)).toEqual({
      lastCheckMs: NOW,
      latestVersion: '0.1.131',
      updateCommand: ['npm', 'install', '-g', '--prefix', '/usr/local', 'infra-kit@0.1.131'],
      outcome: 'install-failed',
    })
  })

  it('pins the install cwd to the home dir so a repo-local .npmrc cannot redirect the registry', async () => {
    // npm resolves `registry=` from an .npmrc on disk relative to cwd. Inheriting the caller's cwd would
    // let any hostile repo silently redirect this unattended `install -g`. Env-stripping cannot fix it.
    const { deps, spawnMock } = harness({ parentPid: 4242 })

    await runUpdateCheck('0.1.130', deps)

    const [, , options] = spawnMock.mock.calls[0] as unknown as [string, string[], { cwd: string }]

    expect(options.cwd).toBe(homedir())
    expect(options.cwd).not.toBe(process.cwd())
  })

  it('burns the throttle BEFORE the install, so a slow install cannot let other shells pile up', async () => {
    // The install has no time bound. Until `lastCheckMs` is on disk the cache still reads STALE, so every
    // new shell spawns its own worker and the single-flight lock — which is reaped by mtime — becomes the
    // only guard. Stamping the throttle up-front is what stops the pile-up at its source.
    const spawnMock = vi.fn(() => {
      // Whatever the cache looks like at install time is what a concurrent shell would read. The
      // 'installing' checkpoint is retryable, so a worker killed here re-checks within the hour.
      expect(cliWrites().at(-1)).toEqual({
        lastCheckMs: NOW,
        latestVersion: '0.1.131',
        updateCommand: null,
        outcome: 'installing',
      })

      return okSpawn()
    })
    const { deps, cliWrites } = harness({ parentPid: 4242, spawnSync: spawnMock as unknown as typeof spawnSync })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('installed')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    // Checkpoint, then the real outcome. The install path is the one path that writes twice, by design.
    expect(cliWrites()).toHaveLength(2)
    expect(cliWrites().at(-1)).toEqual({
      lastCheckMs: NOW,
      latestVersion: null,
      updateCommand: null,
      outcome: 'installed',
    })
  })

  it('writes the cache exactly once when it does not reach the install', async () => {
    const { deps, cliWrites } = harness({ selfRealPath: HOMEBREW_CLI, env: {} })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('cannot-self-spawn')

    expect(cliWrites()).toHaveLength(1)
  })

  it('strips the npx/dlx markers from the install child env', async () => {
    // `pnpm exec` sets npm_command; pnpm then self-aborts believing it was invoked via npx/dlx.
    const { deps, spawnMock } = harness({
      env: { npm_config_prefix: '/usr/local', npm_command: 'exec', PNPM_SCRIPT_SRC_DIR: '/repo', PATH: '/bin' },
    })

    await runUpdateCheck('0.1.130', deps)

    const [, , options] = spawnMock.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }]

    expect(options.env.npm_command).toBeUndefined()
    expect(options.env.PNPM_SCRIPT_SRC_DIR).toBeUndefined()
    expect(options.env.PATH).toBe('/bin')
  })

  it('kEEPS npm_config_prefix, so the install lands in the prefix detection just matched on', async () => {
    // The regression this guards: stripping every `npm_*` key also erased `npm_config_prefix` — the npm
    // matcher's ONLY signal. We detected a global install at /usr/local and then installed into npm's
    // DEFAULT prefix instead, silently: exit 0, `installed` reported, the version on PATH never moves, and
    // the whole cycle repeats every window forever. Verified against the real npm:
    //   npm_config_prefix=/tmp/gp npm root -g  ->  /tmp/gp/lib/node_modules
    //   ( cd $HOME && npm root -g )            ->  /opt/homebrew/lib/node_modules
    const { deps, spawnMock } = harness({
      env: { npm_config_prefix: '/usr/local', npm_command: 'exec', PATH: '/bin' },
    })

    await runUpdateCheck('0.1.130', deps)

    const [, , options] = spawnMock.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }]

    expect(options.env.npm_config_prefix).toBe('/usr/local')
  })

  it('kEEPS npm_config_registry in either case, so the install uses the registry the check queried', async () => {
    // `startsWith('npm_')` is case-sensitive, but npm matches /^npm_config_/i. The uppercase form — what
    // Dockerfiles and CI images actually export — survived the strip while the lowercase form was dropped,
    // so the check and the install pointed at OPPOSITE registries.
    const { deps, spawnMock } = harness({
      env: { npm_config_prefix: '/usr/local', NPM_CONFIG_REGISTRY: 'https://nexus.corp/npm' },
    })

    await runUpdateCheck('0.1.130', deps)

    const [, , options] = spawnMock.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }]

    expect(options.env.NPM_CONFIG_REGISTRY).toBe('https://nexus.corp/npm')
  })
})

/**
 * The Claude Code plugin step. It rides the same worker, AFTER the CLI outcome is settled and its
 * throttle stamp written — the CLI half above must not change shape because of it, and a plugin
 * failure must never reach the CLI outcome.
 *
 * Whether it RUNS follows the cache the locked function wrote, not the outcome's name: a newer
 * `latestVersion` left behind means this run did not deliver the CLI, and the plugin must not get
 * ahead of it. The two tables below split the outcomes by that predicate, and the synthetic cases
 * after them prove it is the predicate — not either list — that decides.
 */
describe('runUpdateCheck — plugin step', () => {
  const record = (projectPath: string): PluginInstallation => {
    return { scope: 'project', projectPath, installPath: null, version: '0.7.0' }
  }

  /** Outcomes whose cache write carries no newer `latestVersion`: the plugin step runs. */
  const ADVANCING: Array<[UpdateCheckOutcome, Partial<RunUpdateCheckDeps>]> = [
    [
      'up-to-date',
      {
        fetchLatest: async () => {
          return '0.1.130'
        },
      },
    ],
    [
      'fetch-failed',
      {
        fetchLatest: async () => {
          return null
        },
      },
    ],
    ['installed', {}],
  ]

  /** Outcomes that leave the newer `latestVersion` in the cache: the plugin step is withheld. */
  const WITHHELD: Array<[UpdateCheckOutcome, Partial<RunUpdateCheckDeps>]> = [
    ['cannot-self-spawn', { selfRealPath: HOMEBREW_CLI, env: {} }],
    ['parent-unknown', { parentPid: undefined }],
    [
      'parent-still-running',
      (() => {
        // The clock advances in `sleep`, not per read: the plugin step's budget reads the same clock.
        let clockMs = NOW

        return {
          isProcessAlive: () => {
            return true
          },
          clock: () => {
            return clockMs
          },
          sleep: async () => {
            clockMs += PARENT_WAIT_TIMEOUT_MS / 2
          },
        }
      })(),
    ],
    [
      'install-failed',
      {
        spawnSync: (() => {
          return { status: 1, signal: null, error: undefined }
        }) as unknown as typeof spawnSync,
      },
    ],
    [
      'install-stale',
      {
        installedVersion: () => {
          return '0.1.130'
        },
      },
    ],
  ]

  /** Every overrides set above, plus an order log of writes, spawns and the lock release. */
  const orderedHarness = (overrides: Partial<RunUpdateCheckDeps>) => {
    const order: string[] = []
    const built = harness({
      ...overrides,
      writeCache: (cache) => {
        order.push(cache.plugin === undefined ? `cli:${String(cache.outcome)}` : `plugin:${cache.plugin.outcome}`)
      },
      listPluginInstallations: () => {
        return [record('/repo')]
      },
      spawnPluginUpdate: (() => {
        order.push('plugin-spawn')

        return okSpawn()
      }) as unknown as typeof spawnSync,
      acquireLock: () => {
        return () => {
          order.push('release')
        }
      },
    })

    return { ...built, order }
  }

  describe.each(ADVANCING)('after a %s outcome', (expected, overrides) => {
    it('runs the plugin update AFTER the outcome is settled, returns that outcome unchanged, then releases the lock', async () => {
      const { deps, cliWrites, releasedCount, order } = orderedHarness(overrides)

      await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe(expected)

      // The CLI's terminal write is the last thing before the plugin spawn; the stamp and the release follow.
      expect(order.slice(-4)).toEqual([`cli:${expected}`, 'plugin-spawn', 'plugin:updated', 'release'])
      expect(cliWrites()).toEqual([])
      expect(releasedCount()).toBe(0)
    })
  })

  describe.each(WITHHELD)('after a %s outcome', (expected, overrides) => {
    it('withholds the plugin update, stamps skipped-cli-stale, returns the outcome unchanged, then releases the lock', async () => {
      const { deps, cliWrites, releasedCount, order, runClaudeMock } = orderedHarness(overrides)

      await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe(expected)

      // No probe and no spawn: the step never started, and the stamp says why.
      expect(order.slice(-3)).toEqual([`cli:${expected}`, 'plugin:skipped-cli-stale', 'release'])
      expect(order).not.toContain('plugin-spawn')
      expect(runClaudeMock).not.toHaveBeenCalled()
      expect(cliWrites()).toEqual([])
      expect(releasedCount()).toBe(0)
    })
  })

  /**
   * The predicate, on its own: a cache-shaped answer, not an outcome name. A future outcome that leaves
   * a newer `latestVersion` behind is withheld without anyone adding it to a list; one that clears it
   * or records a non-newer version advances.
   */
  describe('pluginStepWithheld', () => {
    it('withholds on a newer latestVersion whatever outcome wrote it', () => {
      expect(pluginStepWithheld('0.1.131', '0.1.130')).toBe(true)
      expect(pluginStepWithheld('0.2.0', '0.1.130')).toBe(true)
    })

    it('advances on null (fetch-failed, installed) and on a non-newer version (up-to-date)', () => {
      expect(pluginStepWithheld(null, '0.1.130')).toBe(false)
      expect(pluginStepWithheld('0.1.130', '0.1.130')).toBe(false)
      expect(pluginStepWithheld('0.1.9', '0.1.130')).toBe(false)
    })

    it('never withholds a hand-updated CLI that is already at or past the cached version', () => {
      expect(pluginStepWithheld('0.1.131', '0.1.131')).toBe(false)
      expect(pluginStepWithheld('0.1.131', '0.2.0')).toBe(false)
    })
  })

  it('stamps skipped-cli-stale onto the SAME cache write that carries the newer latestVersion', async () => {
    // The wrapper reads the version out of the locked function's last write and stamps its verdict
    // back onto that write: one object on disk says both "0.9.0 exists" and "so the plugin waited".
    const { deps, writes, pluginSpawnMock, runClaudeMock } = harness({
      fetchLatest: async () => {
        return '0.9.0'
      },
      installedVersion: () => {
        return '0.8.0'
      },
      listPluginInstallations: () => {
        return [record('/repo')]
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('install-stale')

    expect(writes.at(-1)).toEqual({
      lastCheckMs: NOW,
      latestVersion: '0.9.0',
      updateCommand: ['npm', 'install', '-g', '--prefix', '/usr/local', 'infra-kit@0.9.0'],
      outcome: 'install-stale',
      plugin: { outcome: 'skipped-cli-stale', checkedMs: NOW },
    })
    expect(pluginSpawnMock).not.toHaveBeenCalled()
    expect(runClaudeMock).not.toHaveBeenCalled()
  })

  it('stamps the plugin outcome onto the cache the locked function wrote, leaving every CLI field intact', async () => {
    const { deps, writes } = harness({
      fetchLatest: async () => {
        return '0.1.130'
      },
      listPluginInstallations: () => {
        return [record('/repo')]
      },
    })

    await runUpdateCheck('0.1.130', deps)

    expect(writes.at(-1)).toEqual({
      lastCheckMs: NOW,
      latestVersion: '0.1.130',
      updateCommand: null,
      outcome: 'up-to-date',
      plugin: { outcome: 'updated', checkedMs: NOW },
    })
  })

  it('records failed and returns the CLI outcome unchanged when the plugin step throws', async () => {
    const { deps, writes, releasedCount } = harness({
      listPluginInstallations: () => {
        throw new Error('installed_plugins.json exploded')
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('installed')

    expect(writes.at(-1)?.plugin).toEqual({ outcome: 'failed', checkedMs: NOW })
    expect(releasedCount()).toBe(1)
  })

  it('records claude-missing and spawns no update when the probe fails', async () => {
    const { deps, writes, pluginSpawnMock } = harness({
      runClaude: () => {
        return { ok: false, output: 'spawn claude ENOENT' }
      },
      listPluginInstallations: () => {
        return [record('/repo')]
      },
    })

    await runUpdateCheck('0.1.130', deps)

    expect(writes.at(-1)?.plugin?.outcome).toBe('claude-missing')
    expect(pluginSpawnMock).not.toHaveBeenCalled()
  })

  it('records skipped and spawns nothing when no project-scope record exists', async () => {
    const { deps, writes, pluginSpawnMock } = harness()

    await runUpdateCheck('0.1.130', deps)

    expect(writes.at(-1)?.plugin?.outcome).toBe('skipped')
    expect(pluginSpawnMock).not.toHaveBeenCalled()
  })

  it('runs once per recorded project, with that project as cwd, the measured argv, and silent stdio', async () => {
    const { deps, writes, pluginSpawnMock } = harness({
      env: { PATH: '/bin', npm_command: 'exec', PNPM_SCRIPT_SRC_DIR: '/x', CLAUDECODE: '1' },
      listPluginInstallations: () => {
        return [record('/repo/hulyo'), record('/repo/travelist')]
      },
    })

    await runUpdateCheck('0.1.130', deps)

    expect(writes.at(-1)?.plugin?.outcome).toBe('updated')
    expect(pluginSpawnMock).toHaveBeenCalledTimes(2)

    const calls = pluginSpawnMock.mock.calls as unknown as Array<
      [string, string[], { cwd: string; stdio: string; env: NodeJS.ProcessEnv; timeout: number }]
    >

    expect(
      calls.map(([, , options]) => {
        return options.cwd
      }),
    ).toEqual(['/repo/hulyo', '/repo/travelist'])

    for (const [bin, args, options] of calls) {
      // `--scope project -y`: without the scope `claude` resolves USER scope and fails; without `-y` it
      // waits for a confirmation on a stdin that is `ignore`.
      expect([bin, ...args]).toEqual(['claude', ...PLUGIN_UPDATE_ARGV])
      expect(args).toEqual(['plugin', 'update', 'infra-kit@infra-kit', '--scope', 'project', '-y'])
      expect(options.stdio).toBe('ignore')
      expect(options.timeout).toBe(PLUGIN_UPDATE_RUN_TIMEOUT_MS)
      // The npx/dlx markers and the nested-session marker are gone; the rest of the env is intact.
      expect(options.env.npm_command).toBeUndefined()
      expect(options.env.PNPM_SCRIPT_SRC_DIR).toBeUndefined()
      expect(options.env.CLAUDECODE).toBeUndefined()
      expect(options.env.PATH).toBe('/bin')
    }
  })

  it('skips a recorded path that no longer exists and still updates the others', async () => {
    // `installed_plugins.json` is append-only: a deleted checkout keeps its record forever.
    const { deps, writes, pluginSpawnMock } = harness({
      listPluginInstallations: () => {
        return [record('/gone'), record('/repo/live')]
      },
      pathExists: (target) => {
        return target === '/repo/live'
      },
    })

    await runUpdateCheck('0.1.130', deps)

    expect(writes.at(-1)?.plugin?.outcome).toBe('updated')
    expect(pluginSpawnMock).toHaveBeenCalledTimes(1)

    const [, , options] = pluginSpawnMock.mock.calls[0] as unknown as [string, string[], { cwd: string }]

    expect(options.cwd).toBe('/repo/live')
  })

  it('treats an ENOENT from the spawn as the same vanished-path skip, never as a failure', async () => {
    const { deps, writes } = harness({
      listPluginInstallations: () => {
        return [record('/vanished-between-check-and-spawn')]
      },
      spawnPluginUpdate: (() => {
        return {
          status: null,
          signal: null,
          error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
        }
      }) as unknown as typeof spawnSync,
    })

    await runUpdateCheck('0.1.130', deps)

    // Nothing ran, so nothing was updated: the honest verdict is `skipped`.
    expect(writes.at(-1)?.plugin?.outcome).toBe('skipped')
  })

  it('records failed when any project update exits non-zero, after giving every project its turn', async () => {
    const seen: string[] = []
    const { deps, writes } = harness({
      listPluginInstallations: () => {
        return [record('/repo/a'), record('/repo/b')]
      },
      spawnPluginUpdate: ((_bin: string, _args: string[], options: { cwd: string }) => {
        seen.push(options.cwd)

        return options.cwd === '/repo/a' ? { status: 1, signal: null, error: undefined } : okSpawn()
      }) as unknown as typeof spawnSync,
    })

    await runUpdateCheck('0.1.130', deps)

    expect(writes.at(-1)?.plugin?.outcome).toBe('failed')
    expect(seen).toEqual(['/repo/a', '/repo/b'])
  })

  it('stops spawning once the plugin budget is spent and records failed', async () => {
    // The lock is reaped at LOCK_STALE_MS; a plugin step that ran past its budget would hand the next
    // shell a reaped lock and the concurrent-install pile-up the lock exists to prevent.
    let clockMs = NOW
    const spawned: string[] = []
    const { deps, writes } = harness({
      clock: () => {
        return clockMs
      },
      listPluginInstallations: () => {
        return [record('/repo/a'), record('/repo/b')]
      },
      spawnPluginUpdate: ((_bin: string, _args: string[], options: { cwd: string }) => {
        spawned.push(options.cwd)
        clockMs += PLUGIN_UPDATE_BUDGET_MS

        return okSpawn()
      }) as unknown as typeof spawnSync,
    })

    await runUpdateCheck('0.1.130', deps)

    expect(spawned).toEqual(['/repo/a'])
    expect(writes.at(-1)?.plugin?.outcome).toBe('failed')
  })

  it('imports everything statically — no dynamic import() anywhere in the worker path', () => {
    // On the `installed` path the plugin step runs AFTER `npm install -g` has replaced `dist/`; a lazy
    // `import()` of a `chunk-*.js` from the replaced dist is exactly the crash the parent-wait exists
    // to prevent, so nothing on this path may defer a module load.
    for (const file of ['run-update-check.ts', 'update-plugin.ts']) {
      // Comment lines are dropped first: the prose that explains this rule names `import()` by name,
      // and every comment in these files is a whole line (a `/** … */` block or a `//` line).
      const code = fs
        .readFileSync(path.join(__dirname, '..', file), 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trimStart()

          return !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')
        })
        .join('\n')

      expect(code, `${file} must not contain a dynamic import()`).not.toMatch(/\bimport\s*\(/)
    }
  })
})
