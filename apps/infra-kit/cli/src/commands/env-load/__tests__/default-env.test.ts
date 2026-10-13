import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { INFRA_KIT_ENV_TOKEN_VAR } from 'src/integrations/doppler'
import { agentMode } from 'src/lib/agent-mode'
import { INFRA_KIT_SESSION_VAR } from 'src/lib/constants'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { listProjectEnvs } from 'src/lib/project-envs'

import { buildPickerChoices, envLoad } from '../env-load'

const { shellCalls } = vi.hoisted(() => {
  return { shellCalls: [] as Array<{ args: string[] }> }
})

// Same two-stage shape as token-transport.test.ts: `$({ env })` then the tagged `doppler …` call.
vi.mock('zx', () => {
  return {
    $: vi.fn(() => {
      return (_strings: TemplateStringsArray, ...args: string[]) => {
        shellCalls.push({ args })

        const config = args[1] ?? ''

        return {
          timeout: () => {
            return Promise.resolve({ stdout: JSON.stringify({ API_URL: 'https://x', DOPPLER_CONFIG: config }) })
          },
        }
      }
    }),
  }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/lib/project-envs', async (importOriginal) => {
  return { ...(await importOriginal<object>()), listProjectEnvs: vi.fn() }
})

vi.mock('src/lib/git-utils', async (importOriginal) => {
  return { ...(await importOriginal<object>()), getProjectRoot: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }
})

const ORIGINAL_ENV = { ...process.env }

let cacheRoot: string
let repoRoot: string

const withConfig = (extra: Record<string, unknown>): void => {
  vi.mocked(getInfraKitConfig).mockResolvedValue({
    envManagement: { provider: 'doppler', config: { name: 'my-project' } },
    ...extra,
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  shellCalls.length = 0

  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-default-env-'))
  repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-default-env-repo-')))

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INFRA_KIT_')) {
      delete process.env[key]
    }
  }

  process.env.XDG_CACHE_HOME = cacheRoot
  process.env[INFRA_KIT_SESSION_VAR] = 'sess-default'
  process.env[INFRA_KIT_ENV_TOKEN_VAR] = 'dp.st.test'

  agentMode.source = 'flag'
  vi.mocked(getProjectRoot).mockResolvedValue(repoRoot)
  vi.mocked(listProjectEnvs).mockResolvedValue([])
})

afterEach(() => {
  agentMode.source = null
  process.env = { ...ORIGINAL_ENV }
  fs.rmSync(cacheRoot, { recursive: true, force: true })
  fs.rmSync(repoRoot, { recursive: true, force: true })
})

describe('env-load — a configured defaultEnv under an agent', () => {
  it('loads defaultEnv when no config is named, and reports it as the source', async () => {
    withConfig({ defaultEnv: 'roman' })

    const result = await envLoad({})

    expect(shellCalls[0]!.args).toEqual(['my-project', 'roman'])
    expect(result.structuredContent).toMatchObject({ config: 'roman', configSource: 'default' })
  })

  it('lets an explicit config beat defaultEnv', async () => {
    withConfig({ defaultEnv: 'roman' })

    const result = await envLoad({ config: 'dev' })

    expect(shellCalls[0]!.args).toEqual(['my-project', 'dev'])
    expect(result.structuredContent).toMatchObject({ config: 'dev', configSource: 'argument' })
  })

  it('still refuses with argument_required when no layer sets defaultEnv', async () => {
    withConfig({})

    await expect(envLoad({})).rejects.toBeInstanceOf(StructuredRefusalError)
    expect(shellCalls).toHaveLength(0)
  })

  it('refuses rather than fails when the config cannot be read', async () => {
    vi.mocked(getInfraKitConfig).mockRejectedValue(new Error('no infra-kit.json'))

    await expect(envLoad({})).rejects.toBeInstanceOf(StructuredRefusalError)
    expect(shellCalls).toHaveLength(0)
  })
})

describe('buildPickerChoices', () => {
  it('marks the default in place when the env list knows it', () => {
    expect(buildPickerChoices(['dev', 'roman'], 'roman')).toEqual([
      { name: 'dev', value: 'dev' },
      { name: 'roman (default)', value: 'roman' },
    ])
  })

  it('prepends a default the env list does not know, so the cursor has somewhere to open', () => {
    expect(buildPickerChoices(['dev'], 'roman')).toEqual([
      { name: 'roman (default)', value: 'roman' },
      { name: 'dev', value: 'dev' },
    ])
  })

  it('leaves the rows untouched without a default', () => {
    expect(buildPickerChoices(['dev', 'stage'], null)).toEqual([
      { name: 'dev', value: 'dev' },
      { name: 'stage', value: 'stage' },
    ])
  })
})
