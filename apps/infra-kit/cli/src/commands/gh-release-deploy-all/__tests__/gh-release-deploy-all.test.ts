import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveProtectedEnvAccess } from 'src/lib/workflow-envs'

import { ghReleaseDeployAll } from '../gh-release-deploy-all'

const dispatched = vi.hoisted(() => {
  return { commands: [] as string[] }
})

// Capture the tagged template so a test can assert on the exact `gh workflow run` line — and, more
// importantly, assert that NO line was run when the env should have been refused. Asserting only that
// the call rejected would stay green if it rejected for some unrelated reason after dispatching.
vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()

  return {
    ...actual,
    $: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const render = (value: unknown): string => {
        if (value === undefined) return ''

        return Array.isArray(value) ? value.join(' ') : String(value)
      }

      dispatched.commands.push(
        strings.reduce((acc, part, index) => {
          return acc + part + render(values[index])
        }, ''),
      )

      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    }),
  }
})

// Override only the two impure members. `assertDeployable`, `deployableEnvs` and the dispatch warning
// stay REAL — they are the gate under test, and stubbing them would leave this asserting its own mocks.
vi.mock('src/lib/workflow-envs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/workflow-envs')>()

  return {
    ...actual,
    readWorkflowEnvOptions: vi.fn().mockResolvedValue(['dev', 'stage', 'prod']),
    resolveProtectedEnvAccess: vi.fn(),
  }
})

const DENIED = { allowed: false, reason: 'disallow' } as const
const MCP_BLOCKED = { allowed: false, reason: 'mcp-blocked' } as const
const ALLOWED = { allowed: true, reason: 'allowed' } as const

// `confirmedCommand: true` is what the MCP boundary injects on every real tool call, and it
// short-circuits `confirmDeploy` — so this is the agent's path, not a convenience.
const deployProd = async (access: typeof DENIED | typeof ALLOWED | typeof MCP_BLOCKED, env = 'prod') => {
  vi.mocked(resolveProtectedEnvAccess).mockResolvedValue(access)

  return ghReleaseDeployAll({ version: '1.9.0', env, confirmedCommand: true })
}

beforeEach(() => {
  dispatched.commands = []
})

describe('ghReleaseDeployAll — protected environments', () => {
  it('refuses prod by default and dispatches nothing', async () => {
    await expect(deployProd(DENIED)).rejects.toThrow(/delivered, not deployed/)

    expect(dispatched.commands).toEqual([])
  })

  it('refuses prod over MCP when the project allows it CLI-only, and dispatches nothing', async () => {
    await expect(deployProd(MCP_BLOCKED)).rejects.toThrow(/cli-only/)

    expect(dispatched.commands).toEqual([])
  })

  it('dispatches prod when the project allows it', async () => {
    await deployProd(ALLOWED)

    expect(dispatched.commands).toHaveLength(1)
    expect(dispatched.commands[0]).toContain('gh workflow run deploy-all.yml')
    expect(dispatched.commands[0]).toContain('-f environment=prod')
  })

  it('leaves ordinary environments alone when access is denied', async () => {
    await deployProd(DENIED, 'dev')

    expect(dispatched.commands).toHaveLength(1)
    expect(dispatched.commands[0]).toContain('-f environment=dev')
  })
})
