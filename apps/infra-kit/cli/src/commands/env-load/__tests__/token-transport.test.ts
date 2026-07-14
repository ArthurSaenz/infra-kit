import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { INFRA_KIT_ENV_TOKEN_VAR } from 'src/integrations/doppler'
import { ENV_LOAD_FILE, INFRA_KIT_SESSION_VAR, getProjectWarmCacheDir, getSessionCacheDir } from 'src/lib/constants'
import { getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'

import { writeEnvLoadFile } from '../env-load'

/**
 * The token literal every assertion in this file hunts for. If it EVER lands in argv, in
 * env-load.sh, or in the warm cache, a credential has been handed to every process on the box.
 */
const TOKEN = 'dp.st.dev.LEAK_CANARY_0123456789'

const { shellCalls, download } = vi.hoisted(() => {
  return {
    shellCalls: [] as Array<{ options: Record<string, unknown>; command: string; args: string[] }>,
    download: { stdout: '{}', error: null as Error | null },
  }
})

// zx is mocked as the DEFAULT `$` export — a named import is bound at import time and un-spyable.
// The download is invoked as `$({ env })\`doppler …\``, so the mock is a two-stage call: options
// first (which is where the token travels), THEN the tagged template (which is argv).
vi.mock('zx', () => {
  const tagged = (options: Record<string, unknown>) => {
    return (strings: TemplateStringsArray, ...args: string[]) => {
      shellCalls.push({ options, command: strings.join(' <arg> '), args })

      // Only `.timeout(...)` is awaited by the caller, so nothing is settled until it is asked
      // for — an eagerly-created rejected promise would surface as an unhandled rejection.
      return {
        timeout: () => {
          return download.error ? Promise.reject(download.error) : Promise.resolve({ stdout: download.stdout })
        },
      }
    }
  }

  return { $: vi.fn(tagged) }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/lib/git-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/git-utils')>()

  return { ...actual, getProjectRoot: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { warn: vi.fn(), debug: vi.fn() } }
})

/** Every file's contents under `dir`, recursively — the grep surface for the leak assertions. */
const readAllFiles = (dir: string): string[] => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) return readAllFiles(full)

    return entry.isFile() ? [fs.readFileSync(full, 'utf-8')] : []
  })
}

const ORIGINAL_ENV = { ...process.env }

let cacheRoot: string
let repoRoot: string

/** A realistic payload: real secrets, the scope evidence, and the two credential keys we must drop. */
const payload = (config: string): string => {
  return JSON.stringify({
    API_URL: 'https://api.example.com',
    DOPPLER_CONFIG: config,
    DOPPLER_ENVIRONMENT: 'dev',
    DOPPLER_PROJECT: 'my-project',
    DOPPLER_TOKEN: TOKEN,
    INFRA_KIT_ENV_TOKEN: TOKEN,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  shellCalls.length = 0
  download.error = null
  download.stdout = payload('dev')

  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-token-transport-'))
  repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-token-repo-')))

  // Scrub every INFRA_KIT_* var: a leaked INFRA_KIT_SESSION from the dev's real shell would
  // repoint the session cache dir and make every file assertion below vacuous.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INFRA_KIT_')) {
      delete process.env[key]
    }
  }

  process.env.XDG_CACHE_HOME = cacheRoot
  process.env[INFRA_KIT_SESSION_VAR] = 'sess-token'
  process.env[INFRA_KIT_ENV_TOKEN_VAR] = TOKEN

  // The inherited Doppler vars that MUST NOT reach the child (SPIKE-0 Q5).
  process.env.DOPPLER_TOKEN = 'dp.st.INHERITED_AND_WRONG'
  process.env.DOPPLER_PROJECT = 'inherited-project'
  process.env.DOPPLER_CONFIG = 'prod'

  vi.mocked(getInfraKitConfig).mockResolvedValue({
    envManagement: { provider: 'doppler', config: { name: 'my-project' } },
  } as never)
  vi.mocked(getProjectRoot).mockResolvedValue(repoRoot)
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  fs.rmSync(cacheRoot, { recursive: true, force: true })
  fs.rmSync(repoRoot, { recursive: true, force: true })
})

describe('downloadDopplerSecrets — the token travels by env, never by argv', () => {
  it('passes DOPPLER_TOKEN in the CHILD ENV and scrubs the inherited Doppler vars', async () => {
    await writeEnvLoadFile({ config: 'dev' })

    expect(shellCalls).toHaveLength(1)

    const childEnv = shellCalls[0]!.options.env as NodeJS.ProcessEnv

    expect(childEnv.DOPPLER_TOKEN).toBe(TOKEN)
    expect(childEnv).not.toHaveProperty('DOPPLER_PROJECT')
    expect(childEnv).not.toHaveProperty('DOPPLER_CONFIG')
  })

  it('keeps --project/--config in argv and the token OUT of it (ps shows argv to every user)', async () => {
    await writeEnvLoadFile({ config: 'dev' })

    const { command, args } = shellCalls[0]!

    expect(command).toContain('doppler secrets download --no-file --format json --project')
    expect(command).toContain('--config')
    expect(args).toEqual(['my-project', 'dev'])
    expect(args).not.toContain(TOKEN)
    expect(`${command} ${args.join(' ')}`).not.toContain(TOKEN)
  })

  it('runs no `doppler me` / `doppler --version` account probe (token-only: they are meaningless)', async () => {
    await writeEnvLoadFile({ config: 'dev' })

    expect(vi.mocked($)).toHaveBeenCalledOnce()
    expect(shellCalls[0]!.command).not.toContain('doppler me')
  })

  it('translates an auth-class failure into the env-token-set message', async () => {
    download.error = new Error("Doppler Error: This token does not have access to requested config 'dev'")

    await expect(writeEnvLoadFile({ config: 'dev' })).rejects.toThrow(/infra-kit env-token-set dev/u)
  })

  it('throws when the payload is scoped to another config (defense in depth)', async () => {
    download.stdout = payload('prod')

    await expect(writeEnvLoadFile({ config: 'dev' })).rejects.toThrow(/"prod"/u)
  })
})

describe('writeEnvLoadFile — the token reaches no artifact on disk', () => {
  it('writes neither the token nor its keys into env-load.sh, but KEEPS the scope evidence', async () => {
    const result = await writeEnvLoadFile({ config: 'dev' })

    const contents = fs.readFileSync(result!.filePath, 'utf-8')

    expect(contents).not.toContain(TOKEN)
    expect(contents).not.toContain('DOPPLER_TOKEN=')
    expect(contents).not.toContain('INFRA_KIT_ENV_TOKEN=')

    expect(contents).toContain("DOPPLER_CONFIG='dev'")
    expect(contents).toContain("DOPPLER_PROJECT='my-project'")
    expect(contents).toContain("API_URL='https://api.example.com'")
  })

  it('writes no token into the WARM cache either — the file the NEXT shell sources blind', async () => {
    await writeEnvLoadFile({ config: 'dev', autoLoaded: true, projectDir: repoRoot })

    const warmFile = path.join(getProjectWarmCacheDir(repoRoot), ENV_LOAD_FILE)

    expect(fs.existsSync(warmFile)).toBe(true)
    expect(fs.readFileSync(warmFile, 'utf-8')).not.toContain(TOKEN)
  })

  it('leaves no token anywhere under the cache root', async () => {
    await writeEnvLoadFile({ config: 'dev', autoLoaded: true, projectDir: repoRoot })

    const contents = readAllFiles(path.dirname(getSessionCacheDir()))

    // Non-vacuity: the walk really found the artifacts (session file + warm copy).
    expect(contents.length).toBeGreaterThanOrEqual(2)
    expect(contents.join('\n')).not.toContain(TOKEN)
  })
})
