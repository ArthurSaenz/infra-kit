import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { agentMode } from 'src/lib/agent-mode'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { jsonOutput } from 'src/lib/json-output'
import type { ArgumentFormProvider } from 'src/types'

import { refuseMissingArguments } from '../refuse-missing-arguments'

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const SCHEMA = z.object({
  env: z.enum(['dev', 'stage']).describe('where'),
  services: z.array(z.string()).optional(),
})

const provider = (overrides: Partial<ArgumentFormProvider> = {}): ArgumentFormProvider => {
  return {
    message: 'pick',
    isFormable: (params) => {
      return (params as { env?: string }).env === undefined
    },
    buildRequestedSchema: () => {
      return Promise.resolve(SCHEMA)
    },
    toArgs: (content, params) => {
      return { ...(params as object), ...content }
    },
    ...overrides,
  }
}

const refusal = async (input: Parameters<typeof refuseMissingArguments>[0]): Promise<StructuredRefusalError> => {
  const error = await refuseMissingArguments(input).catch((e: unknown) => {
    return e
  })

  expect(error).toBeInstanceOf(StructuredRefusalError)

  return error as StructuredRefusalError
}

afterEach(() => {
  agentMode.source = null
  jsonOutput.enabled = false
})

describe('refuseMissingArguments', () => {
  it.each(['flag', 'env'] as const)(
    'under source %s: argument_required with the form as choices, exit 2',
    async (source) => {
      agentMode.source = source

      const error = await refusal({ provider: provider(), params: {}, operation: 'deploy', argument: 'env' })

      expect(error.exitCode).toBe(2)
      expect(error.structuredContent).toEqual({
        status: 'argument_required',
        argument: 'env',
        choices: z.toJSONSchema(SCHEMA),
        agentMode: source,
      })
      expect(error.message).toContain('pass --env')
    },
  )

  it('fires under --json with no agent source', async () => {
    jsonOutput.enabled = true

    const error = await refusal({ provider: provider(), params: {}, operation: 'deploy', argument: 'env' })

    expect(error.structuredContent.agentMode).toBeNull()
    expect(error.structuredContent.choices).toEqual(z.toJSONSchema(SCHEMA))
  })

  it("is inert under 'mcp' — the chokepoint already ran the form before the handler", async () => {
    agentMode.source = 'mcp'

    await expect(
      refuseMissingArguments({ provider: provider(), params: {}, operation: 'deploy', argument: 'env' }),
    ).resolves.toBeUndefined()
  })

  it('is inert for a human at a TTY, and for complete arguments in any mode', async () => {
    await expect(
      refuseMissingArguments({ provider: provider(), params: {}, operation: 'deploy', argument: 'env' }),
    ).resolves.toBeUndefined()

    agentMode.source = 'flag'

    await expect(
      refuseMissingArguments({ provider: provider(), params: { env: 'dev' }, operation: 'deploy', argument: 'env' }),
    ).resolves.toBeUndefined()
  })

  it('derives the argument from the fields the form offers when given a function', async () => {
    agentMode.source = 'flag'

    const error = await refusal({
      provider: provider(),
      params: {},
      operation: 'deploy',
      argument: (offered) => {
        return `first:${offered.join(',')}`
      },
    })

    expect(error.structuredContent.argument).toBe('first:env,services')
  })

  it('still names the argument, without choices, when the builder has nothing to offer', async () => {
    agentMode.source = 'env'

    const nothing = provider({
      buildRequestedSchema: () => {
        return Promise.resolve(null)
      },
    })
    const error = await refusal({ provider: nothing, params: {}, operation: 'deploy', argument: 'env' })

    expect(error.structuredContent).toEqual({ status: 'argument_required', argument: 'env', agentMode: 'env' })
    expect(error.message).toContain('nothing could be listed')
  })

  it('a builder that throws is treated as "nothing to offer", never as a crash', async () => {
    agentMode.source = 'flag'

    const broken = provider({
      buildRequestedSchema: () => {
        return Promise.reject(new Error('boom'))
      },
    })
    const error = await refusal({
      provider: broken,
      params: {},
      operation: 'deploy',
      argument: (offered) => {
        return offered[0] ?? 'env'
      },
    })

    expect(error.structuredContent).toEqual({ status: 'argument_required', argument: 'env', agentMode: 'flag' })
  })
})
