import type { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'

import { PARENT_WAIT_TIMEOUT_MS, runUpdateCheck } from '../run-update-check'
import type { RunUpdateCheckDeps } from '../run-update-check'
import type { UpdateCache } from '../update-cache'

const GLOBAL_NPM_CLI = '/usr/local/lib/node_modules/infra-kit/dist/cli.js'
const HOMEBREW_CLI = '/opt/homebrew/Cellar/infra-kit/0.1.130/lib/node_modules/infra-kit/dist/cli.js'

const NOW = 1_770_000_000_000

const okSpawn = (): ReturnType<typeof spawnSync> => {
  return { status: 0, signal: null, error: undefined } as unknown as ReturnType<typeof spawnSync>
}

const harness = (overrides: Partial<RunUpdateCheckDeps> = {}) => {
  const writes: UpdateCache[] = []
  const spawnMock = vi.fn(okSpawn)
  let released = 0

  const deps: RunUpdateCheckDeps = {
    selfRealPath: GLOBAL_NPM_CLI,
    // `npm_config_prefix` is what makes detectInstallManager report a self-spawnable npm global.
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
    ...overrides,
  }

  return {
    deps,
    writes,
    spawnMock,
    releasedCount: () => {
      return released
    },
  }
}

describe('runUpdateCheck single-flight lock', () => {
  it('stands down without fetching or writing when another worker holds the lock', async () => {
    const { deps, writes, spawnMock } = harness({
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

    expect([bin, ...args]).toEqual(['npm', 'install', '-g', 'infra-kit@latest'])
    // Silent: a detached child has nowhere to write, and stdout must never carry chatter.
    expect(options.stdio).toBe('ignore')
  })

  it('clears latestVersion after a successful install so the next run does not re-notify', async () => {
    const { deps, writes } = harness()

    await runUpdateCheck('0.1.130', deps)

    expect(writes.at(-1)).toEqual({ lastCheckMs: NOW, latestVersion: null, updateCommand: null })
  })

  it('self-spawns for a plain `npm i -g` install, whose shell has no npm_config_prefix', async () => {
    // REGRESSION: without the `npm root -g` fallback every matcher misses for the most common install
    // method, detection reports `unknown`, and the silent auto-install degrades to a mere notice.
    const { deps, spawnMock } = harness({
      env: {},
      lazyNpmRoot: () => {
        return '/usr/local/lib/node_modules'
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('installed')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('persists lastCheckMs even when the fetch FAILS, so an offline user is not a fetch-storm', async () => {
    // The whole point of the throttle: if lastCheckMs only landed on success, every command an
    // offline user runs would spawn another doomed detached child.
    const { deps, writes, spawnMock } = harness({
      fetchLatest: async () => {
        return null
      },
    })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('fetch-failed')

    expect(writes).toEqual([{ lastCheckMs: NOW, latestVersion: null, updateCommand: null }])
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
    const { deps, writes, spawnMock } = harness({ selfRealPath: HOMEBREW_CLI, env: {} })

    await expect(runUpdateCheck('0.1.130', deps)).resolves.toBe('cannot-self-spawn')

    expect(spawnMock).not.toHaveBeenCalled()
    // The command is recorded so the PARENT can print it without paying for detection on startup.
    expect(writes.at(-1)).toEqual({
      lastCheckMs: NOW,
      latestVersion: '0.1.131',
      updateCommand: ['brew', 'upgrade', 'infra-kit'],
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

  it('records the manual command when the silent install FAILS, so it cannot fail invisibly forever', async () => {
    // e.g. EACCES on a root-owned global dir. Without this the user is told nothing, ever.
    const { deps, writes } = harness({
      parentPid: 4242,
      spawnSync: (() => {
        return { status: 1, signal: null, error: undefined }
      }) as unknown as typeof spawnSync,
    })

    await runUpdateCheck('0.1.130', deps)

    expect(writes.at(-1)).toEqual({
      lastCheckMs: NOW,
      latestVersion: '0.1.131',
      updateCommand: ['npm', 'install', '-g', 'infra-kit@latest'],
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

  it('writes the cache exactly once per run', async () => {
    const { deps, writes } = harness({ parentPid: 4242 })

    await runUpdateCheck('0.1.130', deps)

    expect(writes).toHaveLength(1)
  })

  it('strips inherited npm_* vars from the install child env', async () => {
    // `pnpm exec` sets npm_command; pnpm then self-aborts believing it was invoked via npx/dlx.
    const { deps, spawnMock } = harness({
      env: { npm_config_prefix: '/usr/local', npm_command: 'exec', PATH: '/bin' },
    })

    await runUpdateCheck('0.1.130', deps)

    const [, , options] = spawnMock.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }]

    expect(options.env.npm_command).toBeUndefined()
    expect(options.env.PATH).toBe('/bin')
  })
})
