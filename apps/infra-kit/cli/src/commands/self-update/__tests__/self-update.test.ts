import type { spawnSync } from 'node:child_process'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'

import { runSelfUpdate } from '../self-update'

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`)
  }
}

type SpawnResult = ReturnType<typeof spawnSync>

const okResult = (over: Partial<SpawnResult> = {}): SpawnResult => {
  return { status: 0, signal: null, pid: 1, output: [], stdout: '', stderr: '', ...over } as unknown as SpawnResult
}

const harness = (over: { spawnResult?: SpawnResult } = {}) => {
  const lines: string[] = []
  const spawnSyncFake = vi.fn(() => {
    return over.spawnResult ?? okResult()
  })

  return {
    lines,
    spawnSyncFake,
    deps: {
      spawnSync: spawnSyncFake as unknown as typeof spawnSync,
      print: (line: string) => {
        return lines.push(line)
      },
      exit: ((code: number) => {
        throw new ExitError(code)
      }) as (code: number) => never,
      lazyNpmRoot: () => {
        return undefined
      },
    },
  }
}

const NPM_PATH = '/usr/local/lib/node_modules/infra-kit/dist/cli.js'
const NPM_ENV = { npm_config_prefix: '/usr/local', npm_command: 'exec', PNPM_SCRIPT_SRC_DIR: '/x', PATH: '/bin' }
const BREW_PATH = '/opt/homebrew/Cellar/infra-kit/1.0.0/bin/cli.js'

const expectExit = (fn: () => void): number => {
  try {
    fn()
  } catch (error) {
    if (error instanceof ExitError) return error.code
    throw error
  }
  throw new Error('expected an exit')
}

describe('runSelfUpdate', () => {
  it('spawns the npm global install with a sanitized env', () => {
    const { spawnSyncFake, deps } = harness()

    expect(
      expectExit(() => {
        return runSelfUpdate({ dryRun: false }, { ...deps, selfRealPath: NPM_PATH, env: NPM_ENV })
      }),
    ).toBe(0)

    const [cmd, args, options] = spawnSyncFake.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]

    expect([cmd, ...args]).toEqual(['npm', 'install', '-g', 'infra-kit@latest'])
    expect(options.shell).toBe(process.platform === 'win32')
    expect(options.stdio).toBe('inherit')

    const env = options.env as NodeJS.ProcessEnv

    expect(
      Object.keys(env).some((key) => {
        return key.startsWith('npm_')
      }),
    ).toBe(false)
    expect(env.PNPM_SCRIPT_SRC_DIR).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })

  it('never spawns for a homebrew install and prints the suggestion', () => {
    const { spawnSyncFake, lines, deps } = harness()

    runSelfUpdate({ dryRun: false }, { ...deps, selfRealPath: BREW_PATH, env: {} })

    expect(spawnSyncFake).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('brew upgrade infra-kit')
    expect(lines.join('\n')).toContain('Homebrew')
  })

  it('never spawns for an unknown install', () => {
    const { spawnSyncFake, lines, deps } = harness()

    runSelfUpdate({ dryRun: false }, { ...deps, selfRealPath: '/opt/mystery/infra-kit', env: {} })

    expect(spawnSyncFake).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('unknown')
  })

  it('dry-run prints the resolved command without spawning', () => {
    const { spawnSyncFake, lines, deps } = harness()

    runSelfUpdate({ dryRun: true }, { ...deps, selfRealPath: NPM_PATH, env: NPM_ENV })

    expect(spawnSyncFake).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('npm install -g infra-kit@latest')
    expect(lines.join('\n')).toContain('npm')
  })

  it('reports ENOENT as a non-silent non-zero exit', () => {
    const error = Object.assign(new Error('spawnSync npm ENOENT'), { code: 'ENOENT' })
    const { lines, deps } = harness({ spawnResult: okResult({ error, status: null }) })

    const code = expectExit(() => {
      return runSelfUpdate({ dryRun: false }, { ...deps, selfRealPath: NPM_PATH, env: NPM_ENV })
    })

    expect(code).not.toBe(0)
    expect(lines.join('\n')).toContain('not found')
    expect(lines.join('\n')).toContain('ENOENT')
  })

  it('reports a terminating signal', () => {
    const { lines, deps } = harness({ spawnResult: okResult({ status: null, signal: 'SIGKILL' }) })

    const code = expectExit(() => {
      return runSelfUpdate({ dryRun: false }, { ...deps, selfRealPath: NPM_PATH, env: NPM_ENV })
    })

    expect(code).not.toBe(0)
    expect(lines.join('\n')).toContain('SIGKILL')
  })

  it('forwards the child status', () => {
    const { deps } = harness({ spawnResult: okResult({ status: 7 }) })

    expect(
      expectExit(() => {
        return runSelfUpdate({ dryRun: false }, { ...deps, selfRealPath: NPM_PATH, env: NPM_ENV })
      }),
    ).toBe(7)
  })

  it('exits 1 on a null status with no error or signal', () => {
    const { deps } = harness({ spawnResult: okResult({ status: null }) })

    expect(
      expectExit(() => {
        return runSelfUpdate({ dryRun: false }, { ...deps, selfRealPath: NPM_PATH, env: NPM_ENV })
      }),
    ).toBe(1)
  })
})
