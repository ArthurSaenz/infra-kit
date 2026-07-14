import password from '@inquirer/password'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { commandEcho } from 'src/lib/command-echo'
import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { purgeRepoWarmCaches } from 'src/lib/warm-cache'

import { envTokenSet } from '../env-token-set'

/**
 * The literal every assertion in this file hunts for. If it reaches argv, the echo, or stdout, a live
 * credential has been handed to every user on the box (`ps`), to the shell history, and to the
 * terminal.
 */
const TOKEN = 'dp.st.dev.SET_CANARY_0123456789abcdef'

const { shellCalls, download } = vi.hoisted(() => {
  return {
    shellCalls: [] as Array<{ options: Record<string, unknown>; command: string; args: string[] }>,
    download: { stdout: '{}', error: null as Error | null },
  }
})

// zx is mocked as the DEFAULT `$` export — a named import is bound at import time and un-spyable. The
// probe is `$({ env })\`doppler …\``, so this is a two-stage call: the options (where the token must
// travel) first, then the tagged template (which is argv, where it must NOT).
vi.mock('zx', () => {
  const tagged = (options: Record<string, unknown>) => {
    return (strings: TemplateStringsArray, ...args: string[]) => {
      shellCalls.push({ options, command: strings.join(' <arg> '), args })

      return {
        timeout: () => {
          return download.error ? Promise.reject(download.error) : Promise.resolve({ stdout: download.stdout })
        },
      }
    }
  }

  return { $: vi.fn(tagged) }
})

vi.mock('@inquirer/password', () => {
  return { default: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn(), getMainRepoRoot: vi.fn(), getRepoName: vi.fn() }
})

// The real purge is covered end-to-end (3 real worktrees) in lib/warm-cache/__tests__/purge-repo.test.ts;
// here we only assert that this command CALLS it — the seam that would silently rot.
vi.mock('src/lib/warm-cache', () => {
  return {
    purgeRepoWarmCaches: vi.fn(async () => {
      return ['/warm/a', '/warm/b']
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }
})

const REPO_CONFIG = JSON.stringify({
  envManagement: { provider: 'doppler', config: { name: 'example-project' } },
})

let home: string
let repo: string
let storePath: string

/** A zx-style failure: the CLI's stderr is what every classifier reads. */
const dopplerFailure = (stderr: string): Error => {
  return Object.assign(new Error('exit code: 1'), { stderr })
}

const readStore = (): { envs: Record<string, string> } => {
  return JSON.parse(fs.readFileSync(storePath, 'utf8'))
}

const modeOf = (target: string): string => {
  return (fs.statSync(target).mode & 0o777).toString(8)
}

/** Everything this command said, in one string — the haystack for the leak assertions. */
const everythingLogged = (): string => {
  return [...vi.mocked(logger.info).mock.calls, ...vi.mocked(logger.warn).mock.calls].flat().join('\n')
}

beforeEach(() => {
  // Module mocks (zx, password, the purge, the logger) live for the whole FILE — their call history
  // does not reset itself between tests, and every leak assertion below is a "was never called with"
  // assertion. Without this, one test's calls are another test's evidence.
  vi.clearAllMocks()

  shellCalls.length = 0
  download.stdout = JSON.stringify({ DOPPLER_CONFIG: 'dev', DOPPLER_PROJECT: 'example-project', API_KEY: 'x' })
  download.error = null

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-set-home-'))
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'token-set-repo-')))

  fs.writeFileSync(path.join(repo, 'infra-kit.json'), REPO_CONFIG)

  storePath = path.join(home, '.infra-kit', 'projects', path.basename(repo), 'tokens.json')

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getMainRepoRoot).mockResolvedValue(repo)
  vi.mocked(password).mockResolvedValue(TOKEN)

  resetInfraKitConfigCache()
  commandEcho.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  commandEcho.reset()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('env-token-set — it validates BEFORE it writes', () => {
  /**
   * The likeliest real mistake in production: a human pastes their personal `arthur` token into
   * `env-token-set dev`. Doppler itself refuses the cross-config download (SPIKE-0 Q1), and that
   * refusal must end the command — with nothing on disk.
   */
  it('refuses a mis-scoped token — Doppler rejects the download — and writes nothing', async () => {
    download.error = dopplerFailure("This token does not have access to requested config 'dev'")

    await expect(envTokenSet({ env: 'dev' })).rejects.toThrow(/scoped to a DIFFERENT config/)

    expect(fs.existsSync(storePath), 'a refused token must never reach disk').toBe(false)
    expect(vi.mocked(purgeRepoWarmCaches)).not.toHaveBeenCalled()
  })

  it('refuses a revoked / garbage token, naming the right diagnosis', async () => {
    download.error = dopplerFailure('Doppler Error: Invalid Auth token')

    await expect(envTokenSet({ env: 'dev' })).rejects.toThrow(/invalid or has been revoked/)

    expect(fs.existsSync(storePath)).toBe(false)
  })

  // Defense in depth: the payload disagrees with the request even though the CLI let it through.
  it('refuses when the payload’s DOPPLER_CONFIG names a different config', async () => {
    download.stdout = JSON.stringify({ DOPPLER_CONFIG: 'prod', API_KEY: 'x' })

    await expect(envTokenSet({ env: 'dev' })).rejects.toThrow(/scoped to the wrong config/)

    expect(fs.existsSync(storePath)).toBe(false)
  })

  /**
   * FAIL CLOSED here, unlike `env-load`'s assertTokenScope which fails OPEN on the same input. A human
   * is watching this command: refusing costs them one `--force`. On the silent autoload path nobody is
   * watching, and failing closed would blank every developer's shell at once.
   */
  it('refuses when the scope is UNVERIFIABLE (no DOPPLER_CONFIG in the payload)', async () => {
    download.stdout = JSON.stringify({ API_KEY: 'x' })

    await expect(envTokenSet({ env: 'dev' })).rejects.toThrow(/Could not verify this token's scope/)

    expect(fs.existsSync(storePath)).toBe(false)
  })

  it('--force overrides the UNVERIFIABLE case (and only that case)', async () => {
    download.stdout = JSON.stringify({ API_KEY: 'x' })

    await envTokenSet({ env: 'dev', force: true })

    expect(readStore().envs.dev).toBe(TOKEN)
    expect(everythingLogged()).toMatch(/Scope was NOT verified/)
  })

  it('--force does NOT override a real mismatch', async () => {
    download.stdout = JSON.stringify({ DOPPLER_CONFIG: 'prod' })

    await expect(envTokenSet({ env: 'dev', force: true })).rejects.toThrow(/scoped to the wrong config/)

    expect(fs.existsSync(storePath)).toBe(false)
  })

  /**
   * There is no declared-list veto any more (the removed `environments` array used to be exactly
   * that, and it was stale — it refused `prod_observability`, a config that exists in Doppler and
   * holds a live token, purely because nobody had added the name to infra-kit.json). Doppler is the
   * sole authority, consulted by the probe below — a real token for an undeclared env must still work.
   */
  it('does NOT refuse an env absent from any declared list — Doppler is the sole authority', async () => {
    download.stdout = JSON.stringify({ DOPPLER_CONFIG: 'staging', API_KEY: 'x' })

    const result = await envTokenSet({ env: 'staging' })

    expect(result.structuredContent.env).toBe('staging')
    expect(readStore().envs.staging).toBe(TOKEN)
  })
})

describe('env-token-set — the happy path', () => {
  it('writes the token at 0600 and purges the warm caches of every worktree', async () => {
    const result = await envTokenSet({ env: 'dev' })

    expect(readStore().envs.dev).toBe(TOKEN)
    expect(modeOf(storePath)).toBe('600')

    // A fresh token must not lose to a 2h-old warm cache fetched with the OLD one.
    expect(vi.mocked(purgeRepoWarmCaches)).toHaveBeenCalledTimes(1)
    expect(result.structuredContent.warmCachesPurged).toBe(2)
    expect(result.structuredContent.scopeVerified).toBe(true)
  })

  it('reads the token from --from-env without it ever touching argv', async () => {
    vi.stubEnv('MY_TOKEN', TOKEN)

    const result = await envTokenSet({ env: 'dev', fromEnv: 'MY_TOKEN' })

    expect(readStore().envs.dev).toBe(TOKEN)
    expect(result.structuredContent.source).toBe('env')
    expect(vi.mocked(password)).not.toHaveBeenCalled()
  })

  it('refuses --from-env when the named variable is empty', async () => {
    vi.stubEnv('MY_TOKEN', '')

    await expect(envTokenSet({ env: 'dev', fromEnv: 'MY_TOKEN' })).rejects.toThrow(/MY_TOKEN is not set/)
  })
})

describe('env-token-set — the token never leaks', () => {
  it('travels by child ENV, never in argv', async () => {
    await envTokenSet({ env: 'dev' })

    const probe = shellCalls.at(-1)!

    expect((probe.options.env as NodeJS.ProcessEnv).DOPPLER_TOKEN).toBe(TOKEN)
    expect(probe.args, 'argv is world-visible in `ps`').toEqual(['example-project', 'dev'])
    expect(JSON.stringify(probe.args)).not.toContain(TOKEN)
    expect(probe.command).not.toContain(TOKEN)
  })

  it('never reaches commandEcho — the replay line it prints is a line a user could paste', async () => {
    await envTokenSet({ env: 'dev' })

    expect(JSON.stringify(commandEcho.snapshot())).not.toContain(TOKEN)
    expect(commandEcho.formatOptions()).not.toContain(TOKEN)
  })

  it('never reaches stdout, and is only ever rendered redacted', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    const result = await envTokenSet({ env: 'dev' })

    expect(stdout).not.toHaveBeenCalled()

    expect(everythingLogged()).not.toContain(TOKEN)
    expect(everythingLogged()).toContain('****cdef')

    expect(JSON.stringify(result.structuredContent)).not.toContain(TOKEN)
    expect(result.structuredContent.redactedToken).toBe('****cdef')
  })

  it('prompts on STDERR — stdout is captured by the shell wrapper for some env commands', async () => {
    await envTokenSet({ env: 'dev' })

    expect(vi.mocked(password)).toHaveBeenCalledWith(
      expect.objectContaining({ mask: true }),
      expect.objectContaining({ output: process.stderr }),
    )
  })
})
