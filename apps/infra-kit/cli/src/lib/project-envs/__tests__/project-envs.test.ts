import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readTokenStore } from 'src/lib/env-tokens'
import type { TokenStore } from 'src/lib/env-tokens'
import { listWorkflowEnvs } from 'src/lib/workflow-envs'

import { listProjectEnvNames, listProjectEnvs } from '../project-envs'

// Both authorities are already unit-tested in their own packages
// (`lib/workflow-envs/__tests__`, `lib/env-tokens/__tests__`) — mocked here so this file is only
// about the union/provenance/de-dup logic `listProjectEnvs` adds on top.
vi.mock('src/lib/workflow-envs', () => {
  return { listWorkflowEnvs: vi.fn() }
})

vi.mock('src/lib/env-tokens', () => {
  return { readTokenStore: vi.fn() }
})

const store = (envs: Record<string, string>): TokenStore => {
  return { version: 1, envs }
}

beforeEach(() => {
  vi.mocked(listWorkflowEnvs).mockReset()
  vi.mocked(readTokenStore).mockReset()
})

describe('listProjectEnvs', () => {
  it('unions workflow envs and token-only envs, tagging provenance', async () => {
    vi.mocked(listWorkflowEnvs).mockResolvedValue(['dev', 'stage', 'prod'])
    vi.mocked(readTokenStore).mockResolvedValue(store({ dev: 'dp.st.dev.x', prod_observability: 'dp.st.obs.y' }))

    await expect(listProjectEnvs()).resolves.toEqual([
      { env: 'dev', source: 'gh-workflow' },
      { env: 'stage', source: 'gh-workflow' },
      { env: 'prod', source: 'gh-workflow' },
      { env: 'prod_observability', source: 'token-only' },
    ])
  })

  it('a token-only env (like prod_observability) is present and tagged token-only', async () => {
    vi.mocked(listWorkflowEnvs).mockResolvedValue(['dev'])
    vi.mocked(readTokenStore).mockResolvedValue(store({ dev: 'dp.st.dev.x', prod_observability: 'dp.st.obs.y' }))

    const result = await listProjectEnvs()
    const observability = result.find((entry) => {
      return entry.env === 'prod_observability'
    })

    expect(observability).toEqual({ env: 'prod_observability', source: 'token-only' })
  })

  it('does not duplicate an env that is both workflow-declared and token-held', async () => {
    vi.mocked(listWorkflowEnvs).mockResolvedValue(['dev', 'prod'])
    vi.mocked(readTokenStore).mockResolvedValue(store({ dev: 'dp.st.dev.x', prod: 'dp.st.prod.y' }))

    const result = await listProjectEnvs()

    expect(result).toEqual([
      { env: 'dev', source: 'gh-workflow' },
      { env: 'prod', source: 'gh-workflow' },
    ])
    expect(result).toHaveLength(2)
  })

  it('returns [] when there are zero workflows and zero tokens', async () => {
    vi.mocked(listWorkflowEnvs).mockResolvedValue([])
    vi.mocked(readTokenStore).mockResolvedValue(null)

    await expect(listProjectEnvs()).resolves.toEqual([])
  })

  it('sorts the token-only strays alphabetically, after every workflow env', async () => {
    vi.mocked(listWorkflowEnvs).mockResolvedValue(['dev'])
    vi.mocked(readTokenStore).mockResolvedValue(store({ zeta: 'dp.st.zeta.x', alpha: 'dp.st.alpha.y' }))

    await expect(listProjectEnvs()).resolves.toEqual([
      { env: 'dev', source: 'gh-workflow' },
      { env: 'alpha', source: 'token-only' },
      { env: 'zeta', source: 'token-only' },
    ])
  })

  it('handles an absent token store (fresh machine) the same as an empty one', async () => {
    vi.mocked(listWorkflowEnvs).mockResolvedValue(['dev', 'stage'])
    vi.mocked(readTokenStore).mockResolvedValue(null)

    await expect(listProjectEnvs()).resolves.toEqual([
      { env: 'dev', source: 'gh-workflow' },
      { env: 'stage', source: 'gh-workflow' },
    ])
  })
})

describe('listProjectEnvNames', () => {
  it('returns just the names, in the same order as listProjectEnvs', async () => {
    vi.mocked(listWorkflowEnvs).mockResolvedValue(['dev', 'stage'])
    vi.mocked(readTokenStore).mockResolvedValue(store({ arthur: 'dp.st.arthur.x' }))

    await expect(listProjectEnvNames()).resolves.toEqual(['dev', 'stage', 'arthur'])
  })

  it('returns [] when there is nothing to report', async () => {
    vi.mocked(listWorkflowEnvs).mockResolvedValue([])
    vi.mocked(readTokenStore).mockResolvedValue(null)

    await expect(listProjectEnvNames()).resolves.toEqual([])
  })
})
