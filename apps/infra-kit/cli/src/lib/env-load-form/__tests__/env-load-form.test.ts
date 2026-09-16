import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { envLoadMcpTool } from 'src/commands/env-load'
import { INFRA_KIT_SESSION_VAR } from 'src/lib/constants'
import { readTokenStore } from 'src/lib/env-tokens'
import { logger } from 'src/lib/logger'
import type { ProjectEnv } from 'src/lib/project-envs'
import { listProjectEnvs } from 'src/lib/project-envs'

import { createEnvLoadFormProvider } from '../env-load-form'

vi.mock('src/lib/project-envs', async (importOriginal) => {
  return { ...(await importOriginal<object>()), listProjectEnvs: vi.fn() }
})

vi.mock('src/lib/env-tokens', async (importOriginal) => {
  return { ...(await importOriginal<object>()), readTokenStore: vi.fn() }
})

/** `env-list` order: workflow-declared first, token-only after — the enum must come back untouched. */
const ENVS: ProjectEnv[] = [
  { env: 'dev', source: 'gh-workflow' },
  { env: 'stage', source: 'gh-workflow' },
  { env: 'prod', source: 'gh-workflow' },
  { env: 'arthur', source: 'token-only' },
]

/** Tokens for two of the four: `stage` and `prod` are the token-less ones. */
const populated = (): void => {
  vi.mocked(listProjectEnvs).mockResolvedValue(ENVS)
  vi.mocked(readTokenStore).mockResolvedValue({
    version: 1,
    envs: { dev: 'dp.st.dev.xxxx', arthur: 'dp.st.arthur.xxxx' },
  })
}

interface RenderedField {
  type?: string
  description?: string
  enum?: string[]
}

interface RenderedSchema {
  properties?: Record<string, RenderedField>
  required?: string[]
}

/**
 * Render the provider's schema the way `refuseMissingArguments` ships it in `choices`: JSON Schema,
 * asserted here rather than on the zod object because that is the shape a skill actually reads.
 */
const render = async (params: unknown): Promise<RenderedSchema> => {
  const schema = await createEnvLoadFormProvider().buildRequestedSchema(params)

  expect(schema).not.toBeNull()

  return schema === null ? {} : (z.toJSONSchema(schema) as RenderedSchema)
}

const sessionBefore = process.env[INFRA_KIT_SESSION_VAR]
const tokenBefore = process.env.INFRA_KIT_ENV_TOKEN

beforeEach(() => {
  // An ambient shell token would mark every env as having one and blank the token-less prose.
  delete process.env.INFRA_KIT_ENV_TOKEN
})

afterEach(() => {
  vi.clearAllMocks()

  if (sessionBefore === undefined) delete process.env[INFRA_KIT_SESSION_VAR]
  else process.env[INFRA_KIT_SESSION_VAR] = sessionBefore

  if (tokenBefore === undefined) delete process.env.INFRA_KIT_ENV_TOKEN
  else process.env.INFRA_KIT_ENV_TOKEN = tokenBefore
})

describe('p1 — isFormable', () => {
  it.each([
    [{}, true],
    [{ config: undefined }, true],
    [{ config: '' }, true],
    [{ config: 'dev' }, false],
    [{ config: 42 }, false],
    [null, false],
    [undefined, false],
    ['dev', false],
    [['dev'], false],
  ])('%j → %s', (params, expected) => {
    expect(createEnvLoadFormProvider().isFormable(params)).toBe(expected)
  })
})

describe('p2 — the wire form', () => {
  it('renders a required config enum in listProjectEnvs order', async () => {
    populated()

    const schema = await render({})

    expect(Object.keys(schema.properties ?? {})).toStrictEqual(['config'])
    expect(schema.properties?.config?.enum).toStrictEqual(['dev', 'stage', 'prod', 'arthur'])
    expect(schema.required).toStrictEqual(['config'])
  })
})

describe('p3 — nothing to offer', () => {
  it('returns null and logs the empty-options line instead of an empty enum', async () => {
    vi.mocked(listProjectEnvs).mockResolvedValue([])
    vi.mocked(readTokenStore).mockResolvedValue(null)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})

    await expect(createEnvLoadFormProvider().buildRequestedSchema({})).resolves.toBeNull()
    expect(info).toHaveBeenCalledWith({ msg: 'Tool execution form options empty: env-load' })
  })
})

describe('p4 — the token annotation', () => {
  it('names every token-less env and the env-token-set fix', async () => {
    populated()

    const description = (await render({})).properties?.config?.description ?? ''

    expect(description).toContain('NO stored token for: stage, prod')
    expect(description).toContain('infra-kit env-token-set <env>')
    expect(description).toContain('workflow-declared environments first, then token-only ones')
  })

  it('says so when every env has a token', async () => {
    vi.mocked(listProjectEnvs).mockResolvedValue(ENVS)
    vi.mocked(readTokenStore).mockResolvedValue({
      version: 1,
      envs: { dev: 'x', stage: 'x', prod: 'x', arthur: 'x' },
    })

    const description = (await render({})).properties?.config?.description ?? ''

    expect(description).toContain('A service token is stored for every one of them.')
    expect(description).not.toContain('NO stored token')
  })

  it('treats an unreadable token store as no tokens rather than throwing', async () => {
    vi.mocked(listProjectEnvs).mockResolvedValue(ENVS)
    vi.mocked(readTokenStore).mockRejectedValue(new Error('corrupt store'))

    const description = (await render({})).properties?.config?.description ?? ''

    expect(description).toContain('NO stored token for: dev, stage, prod, arthur')
  })
})

describe('p5 — toArgs', () => {
  const provider = createEnvLoadFormProvider()

  it('merges a chosen config over the round-1 params', () => {
    expect(provider.toArgs({ config: 'dev' }, { config: '', other: 1 })).toStrictEqual({ config: 'dev', other: 1 })
  })

  it('accepts non-record round-1 params', () => {
    expect(provider.toArgs({ config: 'dev' }, undefined)).toStrictEqual({ config: 'dev' })
    expect(provider.toArgs({ config: 'dev' }, 'garbage')).toStrictEqual({ config: 'dev' })
  })

  it.each([[{}], [{ config: '' }], [{ config: 7 }], [{ config: null }], [{ config: ['dev'] }]])(
    'returns null for %j',
    (content) => {
      expect(provider.toArgs(content, {})).toBeNull()
    },
  )
})

describe('p6 — every toArgs output is a valid env-load call', () => {
  it('parses under the tool inputSchema for each enum member', async () => {
    populated()

    const provider = createEnvLoadFormProvider()
    const schema = await provider.buildRequestedSchema({})
    const inputSchema = z.object(envLoadMcpTool.inputSchema)

    expect(schema).not.toBeNull()

    const names = (schema?.shape.config as z.ZodEnum<Record<string, string>>).options

    expect(names).toStrictEqual(['dev', 'stage', 'prod', 'arthur'])

    for (const config of names) {
      const args = provider.toArgs({ config }, {})

      expect(args).not.toBeNull()
      expect(inputSchema.safeParse(args).success).toBe(true)
    }
  })
})

describe('p7 — message', () => {
  it('reads INFRA_KIT_SESSION at access time, not at construction', () => {
    const provider = createEnvLoadFormProvider()

    process.env[INFRA_KIT_SESSION_VAR] = 'deadbeef'

    expect(provider.message).toContain('terminal session deadbeef')
    expect(provider.message).toContain('there is no further prompt')

    process.env[INFRA_KIT_SESSION_VAR] = 'cafef00d'

    expect(provider.message).toContain('terminal session cafef00d')
  })

  it('says the load will fail when the session id is missing', () => {
    delete process.env[INFRA_KIT_SESSION_VAR]

    expect(createEnvLoadFormProvider().message).toContain('UNKNOWN — INFRA_KIT_SESSION is not set, the load will fail')
  })
})

describe('p8 — a failed enumeration', () => {
  it('returns null when listProjectEnvs rejects', async () => {
    vi.mocked(listProjectEnvs).mockRejectedValue(new Error('no repo'))
    vi.mocked(readTokenStore).mockResolvedValue(null)
    vi.spyOn(logger, 'info').mockImplementation(() => {})

    await expect(createEnvLoadFormProvider().buildRequestedSchema({})).resolves.toBeNull()
  })
})
