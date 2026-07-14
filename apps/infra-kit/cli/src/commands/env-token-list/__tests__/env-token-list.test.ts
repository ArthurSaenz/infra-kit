import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { INFRA_KIT_ENV_TOKEN_VAR } from 'src/integrations/doppler'
import { setToken } from 'src/lib/env-tokens'
import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { listProjectEnvNames } from 'src/lib/project-envs'

import { envTokenList } from '../env-token-list'

const DEV_TOKEN = 'dp.st.dev.LIST_CANARY_dev_00001111'
const PROD_TOKEN = 'dp.st.prod.LIST_CANARY_prod_2222aaaa'
const CI_TOKEN = 'dp.st.ci.LIST_CANARY_ci_3333bbbb'

/** Per-config canned `doppler secrets get DOPPLER_CONFIG` outcomes, keyed by the `--config` argv value. */
const { probes, shellCalls } = vi.hoisted(() => {
  return {
    probes: {} as Record<string, { stdout?: string; error?: Error }>,
    shellCalls: [] as Array<{ options: Record<string, unknown>; args: string[] }>,
  }
})

// zx as the DEFAULT `$` export (a named import is un-spyable). probeEnvToken calls
// `$({ env })\`doppler secrets get DOPPLER_CONFIG --plain --project <p> --config <c>\``, so args[2] is
// the config — which is how one mock serves a different verdict per environment.
vi.mock('zx', () => {
  const tagged = (options: Record<string, unknown>) => {
    return (_strings: TemplateStringsArray, ...args: string[]) => {
      shellCalls.push({ options, args })

      const probe = probes[args[2] ?? ''] ?? {}

      return {
        timeout: () => {
          return probe.error ? Promise.reject(probe.error) : Promise.resolve({ stdout: probe.stdout ?? '' })
        },
      }
    }
  }

  return { $: vi.fn(tagged) }
})

vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn(), getMainRepoRoot: vi.fn(), getRepoName: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }
})

// `listProjectEnvNames` (workflow union + token store) has its own tests
// (`lib/project-envs/__tests__`) — mocked here so this file stays about the token table.
vi.mock('src/lib/project-envs', () => {
  return { listProjectEnvNames: vi.fn() }
})

const REPO_CONFIG = JSON.stringify({
  envManagement: { provider: 'doppler', config: { name: 'example-project' } },
})

let home: string
let repo: string

const dopplerFailure = (stderr: string): Error => {
  return Object.assign(new Error('exit code: 1'), { stderr })
}

/** Everything the command printed, as one blob — the table and the leak haystack. */
const printed = (): string => {
  return vi.mocked(logger.info).mock.calls.flat().join('\n')
}

beforeEach(async () => {
  vi.clearAllMocks()
  shellCalls.length = 0

  for (const key of Object.keys(probes)) delete probes[key]

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-list-home-'))
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'token-list-repo-')))

  fs.writeFileSync(path.join(repo, 'infra-kit.json'), REPO_CONFIG)

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getMainRepoRoot).mockResolvedValue(repo)
  vi.mocked(listProjectEnvNames).mockResolvedValue(['dev', 'prod', 'ci', 'staging'])

  resetInfraKitConfigCache()

  await setToken('dev', DEV_TOKEN)
  await setToken('prod', PROD_TOKEN)
  await setToken('ci', CI_TOKEN)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('env-token-list — redacted output only', () => {
  it('prints one row per declared env, with the token redacted to its last 4 chars', async () => {
    const result = await envTokenList()

    const output = printed()

    for (const token of [DEV_TOKEN, PROD_TOKEN, CI_TOKEN]) {
      expect(output, 'a raw token must never be rendered').not.toContain(token)
    }

    expect(output).toContain('****1111')
    expect(JSON.stringify(result.structuredContent)).not.toContain(DEV_TOKEN)

    expect(result.structuredContent.tokens).toHaveLength(4)
    expect(result.structuredContent.tokens[0]).toMatchObject({
      env: 'dev',
      source: 'store',
      redactedToken: '****1111',
      present: true,
    })
  })

  it('reports the env with NO token as absent, and points at the fix', async () => {
    const result = await envTokenList()

    expect(result.structuredContent.tokens[3]).toMatchObject({ env: 'staging', source: '-', present: false })
    expect(printed()).toContain('infra-kit env-token-set <env>')
  })

  /**
   * `INFRA_KIT_ENV_TOKEN` shadows the store for EVERY env — that is exactly how `resolveEnvToken`
   * resolves it, so the listing must say so rather than showing a store token the loader will not use.
   */
  it('reports INFRA_KIT_ENV_TOKEN as the source for every env when it is set', async () => {
    vi.stubEnv(INFRA_KIT_ENV_TOKEN_VAR, 'dp.st.ci.FROM_THE_ENV_9999zzzz')

    const result = await envTokenList()

    for (const row of result.structuredContent.tokens) {
      expect(row.source).toBe(`env:${INFRA_KIT_ENV_TOKEN_VAR}`)
      expect(row.redactedToken).toBe('****zzzz')
    }
  })
})

describe('env-token-list --check — valid / revoked / mis-scoped, told apart', () => {
  it('reports each outcome distinctly, and never probes an env with no token', async () => {
    probes.dev = { stdout: 'dev\n' }
    probes.prod = { error: dopplerFailure('Doppler Error: Invalid Auth token') }
    probes.ci = { error: dopplerFailure("This token does not have access to requested config 'ci'") }

    const result = await envTokenList({ check: true })

    const status = Object.fromEntries(
      result.structuredContent.tokens.map((row) => {
        return [row.env, row.status]
      }),
    )

    expect(status).toEqual({ dev: 'valid', prod: 'revoked', ci: 'mis-scoped', staging: undefined })

    // 3 tokens, 3 probes: the env without a token must cost nothing.
    expect(shellCalls).toHaveLength(3)
  })

  /**
   * A network failure must report "couldn't tell", never a verdict. Telling a developer on a plane
   * that their token was revoked is the failure mode this guards.
   */
  it('reports an unreachable Doppler as "unreachable", not as a bad token', async () => {
    probes.dev = { error: new Error('connect ETIMEDOUT') }
    probes.prod = { stdout: 'prod' }
    probes.ci = { stdout: 'ci' }

    const result = await envTokenList({ check: true })

    expect(result.structuredContent.tokens[0]?.status).toBe('unreachable')
  })

  it('sends the token by child ENV, never in argv', async () => {
    probes.dev = { stdout: 'dev' }
    probes.prod = { stdout: 'prod' }
    probes.ci = { stdout: 'ci' }

    await envTokenList({ check: true })

    const devProbe = shellCalls[0]!

    expect((devProbe.options.env as NodeJS.ProcessEnv).DOPPLER_TOKEN).toBe(DEV_TOKEN)
    expect(devProbe.args).toEqual(['DOPPLER_CONFIG', 'example-project', 'dev'])
    expect(printed()).not.toContain(DEV_TOKEN)
  })
})
