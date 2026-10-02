import confirm from '@inquirer/confirm'
import input from '@inquirer/input'
import password from '@inquirer/password'
import select from '@inquirer/select'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { listProjectEnvs } from 'src/lib/project-envs'

import { envTokenSet, envTokenSetFromFile, parseTokenFile } from '../env-token-set'

/**
 * The literal every assertion in this file hunts for. If it reaches argv, the echo, or stdout, a live
 * credential has been handed to every user on the box (`ps`), to the shell history, and to the
 * terminal.
 */
const TOKEN = 'dp.st.dev.SET_CANARY_0123456789abcdef'

const { shellCalls, download } = vi.hoisted(() => {
  return {
    shellCalls: [] as Array<{ options: Record<string, unknown>; command: string; args: string[] }>,
    download: { stdout: '{}', error: null as Error | null, failForConfig: null as string | null },
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
          if (download.failForConfig !== null && args[1] === download.failForConfig) {
            return Promise.reject(
              Object.assign(new Error('exit code: 1'), { stderr: 'Doppler Error: Invalid Auth token' }),
            )
          }

          // A bulk import probes several configs; each payload must name the config it was asked for.
          const stdout = download.stdout.replace('"DOPPLER_CONFIG":"dev"', `"DOPPLER_CONFIG":"${args[1]}"`)

          return download.error ? Promise.reject(download.error) : Promise.resolve({ stdout })
        },
      }
    }
  }

  return { $: vi.fn(tagged) }
})

vi.mock('@inquirer/password', () => {
  return { default: vi.fn() }
})

vi.mock('@inquirer/confirm', () => {
  return { default: vi.fn() }
})

vi.mock('@inquirer/select', () => {
  return { default: vi.fn() }
})

vi.mock('@inquirer/input', () => {
  return { default: vi.fn() }
})

vi.mock('src/lib/project-envs', () => {
  return { listProjectEnvs: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn(), getMainRepoRoot: vi.fn(), getRepoName: vi.fn() }
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
let stdinTTY: PropertyDescriptor | undefined

const pipeStdin = (content: string): void => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin)
  Object.defineProperty(process.stdin, Symbol.asyncIterator, {
    configurable: true,
    value: () => {
      return Readable.from([content])[Symbol.asyncIterator]()
    },
  })
}

const writeStore = (envs: Record<string, string>): void => {
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, envs }))
}

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
  // Module mocks (zx, password, the logger) live for the whole FILE — their call history
  // does not reset itself between tests, and every leak assertion below is a "was never called with"
  // assertion. Without this, one test's calls are another test's evidence.
  vi.clearAllMocks()

  shellCalls.length = 0
  download.stdout = JSON.stringify({ DOPPLER_CONFIG: 'dev', DOPPLER_PROJECT: 'example-project', API_KEY: 'x' })
  download.error = null
  download.failForConfig = null
  stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  // vitest's stdin is not a TTY, and a non-TTY stdin now IS the token channel. Every test that wants
  // the prompt path says so by default; the pipe tests flip it back.
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

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
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY)
  else Reflect.deleteProperty(process.stdin, 'isTTY')
  Reflect.deleteProperty(process.stdin, Symbol.asyncIterator)
  agentMode.source = null
  vi.unstubAllEnvs()
  process.exitCode = undefined
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
   * is watching this command: refusing costs them one `--force`. `env-load` has no such escape hatch,
   * and failing closed there would blank every developer's shell at once.
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
  it('writes the token at 0600', async () => {
    const result = await envTokenSet({ env: 'dev' })

    expect(readStore().envs.dev).toBe(TOKEN)
    expect(modeOf(storePath)).toBe('600')
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

describe('env-token-set — replacing an existing token', () => {
  const OLD = 'dp.st.dev.OLD_TOKEN_00000000wxyz'

  it('replaces a piped token silently and reports both redacted values', async () => {
    writeStore({ dev: OLD })
    vi.stubEnv('MY_TOKEN', TOKEN)

    const result = await envTokenSet({ env: 'dev', fromEnv: 'MY_TOKEN' })

    expect(readStore().envs.dev).toBe(TOKEN)
    expect(result.structuredContent).toMatchObject({
      status: 'replaced',
      previousRedactedToken: '****wxyz',
      redactedToken: '****cdef',
    })
    expect(vi.mocked(confirm)).not.toHaveBeenCalled()
    expect(everythingLogged()).toContain('****wxyz → ****cdef')
  })

  it('asks a human at the prompt before replacing, and keeps the old token on "no"', async () => {
    writeStore({ dev: OLD })
    vi.mocked(confirm).mockResolvedValue(false)

    const result = await envTokenSet({ env: 'dev' })

    expect(vi.mocked(confirm)).toHaveBeenCalledOnce()
    expect(readStore().envs.dev).toBe(OLD)
    expect(result.structuredContent.status).toBe('kept')
  })

  it('writes nothing when the token is the one already stored', async () => {
    writeStore({ dev: TOKEN })
    const before = fs.statSync(storePath).mtimeMs

    const result = await envTokenSet({ env: 'dev' })

    expect(result.structuredContent.status).toBe('unchanged')
    expect(vi.mocked(confirm)).not.toHaveBeenCalled()
    expect(fs.statSync(storePath).mtimeMs).toBe(before)
  })
})

describe('env-token-set — a piped stdin is the token, no flag needed', () => {
  it('reads the token from a non-TTY stdin without prompting', async () => {
    pipeStdin(`${TOKEN}\n`)

    const result = await envTokenSet({ env: 'dev' })

    expect(readStore().envs.dev).toBe(TOKEN)
    expect(result.structuredContent.source).toBe('stdin')
    expect(vi.mocked(password)).not.toHaveBeenCalled()
  })

  it('refuses an EMPTY pipe for a human instead of prompting into EOF', async () => {
    pipeStdin('')

    await expect(envTokenSet({ env: 'dev' })).rejects.toThrow(/carried no token/)
    expect(vi.mocked(password)).not.toHaveBeenCalled()
  })

  it('turns an empty pipe under --agent into argument_required naming stdin', async () => {
    pipeStdin('')
    agentMode.source = 'flag'

    await expect(envTokenSet({ env: 'dev' })).rejects.toMatchObject({
      structuredContent: { status: 'argument_required', argument: 'stdin' },
    })
  })
})

describe('env-token-set — no <env> given', () => {
  it('refuses under --agent with argument_required naming env', async () => {
    agentMode.source = 'flag'

    await expect(envTokenSet({})).rejects.toMatchObject({
      structuredContent: { status: 'argument_required', argument: 'env' },
    })
    expect(vi.mocked(select)).not.toHaveBeenCalled()
  })

  it('offers the known envs, marked set / not set, plus a new-env row', async () => {
    writeStore({ dev: TOKEN })
    vi.mocked(listProjectEnvs).mockResolvedValue([
      { env: 'dev', source: 'gh-workflow' },
      { env: 'stage', source: 'gh-workflow' },
    ])
    vi.mocked(select).mockResolvedValue('dev')
    vi.mocked(password).mockResolvedValue(TOKEN)

    await envTokenSet({})

    const { choices } = vi.mocked(select).mock.calls[0]![0] as unknown as { choices: Array<{ name: string }> }

    expect(
      choices.map((choice) => {
        return choice.name
      }),
    ).toEqual(['dev    set — replace', 'stage  not set', '+ new env…'])
  })

  it('takes a typed name for a new env and lets Doppler decide it is real', async () => {
    vi.mocked(listProjectEnvs).mockResolvedValue([{ env: 'dev', source: 'gh-workflow' }])
    vi.mocked(select).mockImplementation(async (config) => {
      return (config as unknown as { choices: Array<{ value: string }> }).choices.at(-1)!.value
    })
    vi.mocked(input).mockResolvedValue(' staging ')
    download.stdout = JSON.stringify({ DOPPLER_CONFIG: 'staging' })

    const result = await envTokenSet({})

    expect(result.structuredContent.env).toBe('staging')
    expect(readStore().envs.staging).toBe(TOKEN)
    expect(shellCalls.at(-1)!.args).toEqual(['example-project', 'staging'])
  })
})

describe('env-token-set --from-file', () => {
  it('parses env=token lines, comments, blanks and quotes', () => {
    expect(parseTokenFile('# team\n\ndev=dp.st.dev.a\narthur = "dp.st.arthur.b"\n')).toEqual([
      { env: 'dev', token: 'dp.st.dev.a' },
      { env: 'arthur', token: 'dp.st.arthur.b' },
    ])
  })

  it('names the bad line, never its content', () => {
    expect(() => {
      return parseTokenFile(`dev=a\n${TOKEN}\n`)
    }).toThrow(/line 2/)

    expect(() => {
      return parseTokenFile(`dev=a\n${TOKEN}\n`)
    }).not.toThrow(new RegExp(TOKEN))
  })

  it('refuses a duplicated env and an empty file', () => {
    expect(() => {
      return parseTokenFile('dev=a\ndev=b\n')
    }).toThrow(/appears twice/)
    expect(() => {
      return parseTokenFile('# nothing\n')
    }).toThrow(/no `<env>=<token>` lines/)
  })

  it('stores what Doppler accepts, reports what it refuses, and exits 1', async () => {
    const file = path.join(home, 'tokens.env')

    writeStore({ arthur: 'dp.st.arthur.SAME' })
    fs.writeFileSync(file, `dev=${TOKEN}\nstage=dp.st.stage.BAD_00001111\narthur=dp.st.arthur.SAME\n`)
    download.failForConfig = 'stage'

    const result = await envTokenSetFromFile({ fromFile: file })

    expect(
      result.structuredContent.rows.map((row) => {
        return [row.env, row.status]
      }),
    ).toEqual([
      ['dev', 'stored'],
      ['stage', 'failed'],
      ['arthur', 'unchanged'],
    ])
    expect(readStore().envs).toEqual({ arthur: 'dp.st.arthur.SAME', dev: TOKEN })
    expect(process.exitCode).toBe(1)
    expect(everythingLogged()).not.toContain(TOKEN)
  })
})
