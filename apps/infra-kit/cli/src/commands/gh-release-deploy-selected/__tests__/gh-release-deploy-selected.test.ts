import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveProtectedEnvAccess } from 'src/lib/workflow-envs'

import { ghReleaseDeploySelected } from '../gh-release-deploy-selected'

const dispatched = vi.hoisted(() => {
  return { commands: [] as string[] }
})

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()

  return {
    ...actual,
    $: vi.fn((strings: TemplateStringsArray) => {
      dispatched.commands.push(strings.join(''))

      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    }),
  }
})

// Override only the two impure members — the gate itself stays real, or this would assert its own mocks.
vi.mock('src/lib/workflow-envs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/workflow-envs')>()

  return {
    ...actual,
    readWorkflowEnvOptions: vi.fn().mockResolvedValue(['dev', 'stage', 'prod']),
    resolveProtectedEnvAccess: vi.fn(),
  }
})

// Pin the root at a path with no .github/workflows, so `parseServicesFromWorkflow` returns [] and the
// run stops at a NAMED downstream gate. Without this the zx mock above makes `getProjectRoot` itself
// fail, and the tests below would pass on an incidental error rather than the one they claim.
vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn().mockResolvedValue('/nonexistent-infra-kit-test-root') }
})

const DENIED = { allowed: false, reason: 'disallow' } as const
const MCP_BLOCKED = { allowed: false, reason: 'mcp-blocked' } as const
const ALLOWED = { allowed: true, reason: 'allowed' } as const

const deploy = async (access: typeof DENIED | typeof ALLOWED | typeof MCP_BLOCKED, env = 'prod') => {
  vi.mocked(resolveProtectedEnvAccess).mockResolvedValue(access)

  return ghReleaseDeploySelected({ version: '1.9.0', env, services: ['client-be'], confirmedCommand: true })
}

beforeEach(() => {
  dispatched.commands = []
})

describe('ghReleaseDeploySelected — protected environments', () => {
  it('refuses prod by default and dispatches nothing', async () => {
    await expect(deploy(DENIED)).rejects.toThrow(/delivered, not deployed/)

    expect(dispatched.commands).toEqual([])
  })

  it('refuses prod over MCP when the project allows it CLI-only, and dispatches nothing', async () => {
    await expect(deploy(MCP_BLOCKED)).rejects.toThrow(/cli-only/)

    expect(dispatched.commands).toEqual([])
  })

  // This repo declares no deploy-selected-services.yml, so the run cannot reach a dispatch — which is
  // exactly what makes the assertion sharp. Getting PAST the protected-env gate is proven by failing at
  // the NEXT gate instead of at this one; a regression that re-refuses prod would throw
  // "delivered, not deployed" here and this test would go red.
  it('lets an allowed prod past the protected-env gate', async () => {
    await expect(deploy(ALLOWED)).rejects.toThrow(/no services found/)

    await expect(deploy(ALLOWED)).rejects.not.toThrow(/delivered, not deployed/)
  })

  it('leaves ordinary environments at the same downstream gate', async () => {
    await expect(deploy(DENIED, 'dev')).rejects.toThrow(/no services found/)
  })
})
