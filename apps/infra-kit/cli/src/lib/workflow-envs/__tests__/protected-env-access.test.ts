import { afterEach, describe, expect, it, vi } from 'vitest'

import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { mcpMode } from 'src/lib/mcp-mode'

import { resolveProtectedEnvAccess } from '../protected-env-access'

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

const withConfig = (protectedEnvs?: string): void => {
  vi.mocked(getInfraKitConfig).mockResolvedValue({
    envManagement: { provider: 'doppler', config: { name: 'p' } },
    ...(protectedEnvs === undefined ? {} : { protectedEnvs }),
  } as Awaited<ReturnType<typeof getInfraKitConfig>>)
}

afterEach(() => {
  // `mcpMode.enabled` is mutable module state shared across every test FILE in the run, not just this
  // one. Leaving it true here would silently flip unrelated suites into MCP behaviour.
  mcpMode.enabled = false
  vi.restoreAllMocks()
})

describe('resolveProtectedEnvAccess', () => {
  it('denies when the key is absent — the fallback lives here, not in the schema', async () => {
    withConfig(undefined)

    expect(await resolveProtectedEnvAccess()).toEqual({ allowed: false, reason: 'disallow' })
  })

  it('denies on "disallow"', async () => {
    withConfig('disallow')

    expect(await resolveProtectedEnvAccess()).toEqual({ allowed: false, reason: 'disallow' })
  })

  it('allows on "allow"', async () => {
    withConfig('allow')

    expect(await resolveProtectedEnvAccess()).toEqual({ allowed: true, reason: 'allowed' })
  })

  // Never throws: `getInfraKitConfig` genuinely throws for a repo with no infra-kit.json, and turning
  // every deploy into a config-parse error would be a regression. Refusing on a config we cannot read
  // is the correct direction to fail.
  it('denies instead of throwing when the config cannot be read', async () => {
    vi.mocked(getInfraKitConfig).mockRejectedValue(new Error('infra-kit.json not found'))

    await expect(resolveProtectedEnvAccess()).resolves.toEqual({ allowed: false, reason: 'disallow' })
  })

  describe('cli-only', () => {
    it('allows on the CLI', async () => {
      withConfig('cli-only')
      mcpMode.enabled = false

      expect(await resolveProtectedEnvAccess()).toEqual({ allowed: true, reason: 'allowed' })
    })

    // The branch the whole third enum value exists for. Note it asserts the REASON too: a bare boolean
    // here would make an agent's refusal read as "prod is delivered, not deployed", sending it off to
    // run the delivery flow instead of telling the human to run it in a terminal.
    it('denies over MCP, with a reason distinct from a plain disallow', async () => {
      withConfig('cli-only')
      mcpMode.enabled = true

      expect(await resolveProtectedEnvAccess()).toEqual({ allowed: false, reason: 'mcp-blocked' })
    })

    it('is unaffected by MCP mode when the project says "allow"', async () => {
      withConfig('allow')
      mcpMode.enabled = true

      expect(await resolveProtectedEnvAccess()).toEqual({ allowed: true, reason: 'allowed' })
    })
  })
})
