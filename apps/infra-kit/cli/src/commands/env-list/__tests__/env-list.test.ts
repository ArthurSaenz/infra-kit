import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { INFRA_KIT_ENV_TOKEN_VAR } from 'src/integrations/doppler'
import { setToken } from 'src/lib/env-tokens'
import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { listProjectEnvs } from 'src/lib/project-envs'

import { buildEnvTokenStatus, envList } from '../env-list'

const DEV_TOKEN = 'dp.st.dev.LIST_CANARY_dev_00001111'

vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn(), getMainRepoRoot: vi.fn(), getRepoName: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }
})

// `listProjectEnvs` (workflow union + token store) is its own module with its own tests
// (`lib/project-envs/__tests__`) — mocked here so env-list's tests stay about rendering
// and token-status, not workflow-YAML fixtures.
vi.mock('src/lib/project-envs', () => {
  return { listProjectEnvs: vi.fn() }
})

const REPO_CONFIG = JSON.stringify({
  envManagement: { provider: 'doppler', config: { name: 'example-project' } },
})

let home: string
let repo: string

/** Everything the command printed, as one blob — the table and the leak haystack. */
const printed = (): string => {
  return vi.mocked(logger.info).mock.calls.flat().join('\n')
}

beforeEach(async () => {
  vi.clearAllMocks()

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'env-list-home-'))
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'env-list-repo-')))

  fs.writeFileSync(path.join(repo, 'infra-kit.json'), REPO_CONFIG)

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

  // Default: two workflow-declared envs, matching what the old `environments: ['dev', 'staging']`
  // fixture used to declare. Individual tests override this.
  vi.mocked(listProjectEnvs).mockResolvedValue([
    { env: 'dev', source: 'workflow' },
    { env: 'staging', source: 'workflow' },
  ])

  resetInfraKitConfigCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('buildEnvTokenStatus', () => {
  it('reports hasToken from the store, and a fix hint when absent', () => {
    expect(
      buildEnvTokenStatus(
        [
          { env: 'dev', source: 'workflow' },
          { env: 'prod', source: 'workflow' },
        ],
        { dev: 'dp.st.dev.xxxx' },
        undefined,
      ),
    ).toEqual([
      { env: 'dev', source: 'workflow', hasToken: true },
      { env: 'prod', source: 'workflow', hasToken: false, hint: 'infra-kit env-token-set prod' },
    ])
  })

  it('treats INFRA_KIT_ENV_TOKEN as covering every env, same as resolveEnvToken precedence', () => {
    expect(
      buildEnvTokenStatus(
        [
          { env: 'dev', source: 'workflow' },
          { env: 'prod', source: 'token-only' },
        ],
        {},
        'dp.st.from-env.xxxx',
      ),
    ).toEqual([
      { env: 'dev', source: 'workflow', hasToken: true },
      { env: 'prod', source: 'token-only', hasToken: true },
    ])
  })

  it('carries the source through unchanged (workflow vs token-only)', () => {
    expect(buildEnvTokenStatus([{ env: 'prod_observability', source: 'token-only' }], {}, undefined)).toEqual([
      {
        env: 'prod_observability',
        source: 'token-only',
        hasToken: false,
        hint: 'infra-kit env-token-set prod_observability',
      },
    ])
  })
})

describe('envList — token column', () => {
  it('marks an env with a stored token as present, never rendering the token value', async () => {
    await setToken('dev', DEV_TOKEN)

    const result = await envList()

    expect(result.structuredContent.tokens).toEqual([
      { env: 'dev', source: 'workflow', hasToken: true },
      { env: 'staging', source: 'workflow', hasToken: false, hint: 'infra-kit env-token-set staging' },
    ])

    const output = printed()

    expect(output).not.toContain(DEV_TOKEN)
    expect(output).toContain('dev (token set)')
    expect(output).toContain('staging (no token — run `infra-kit env-token-set staging`)')
  })

  it('still lists every env with no network call when no token exists anywhere', async () => {
    const result = await envList()

    expect(result.structuredContent.tokens).toEqual([
      { env: 'dev', source: 'workflow', hasToken: false, hint: 'infra-kit env-token-set dev' },
      { env: 'staging', source: 'workflow', hasToken: false, hint: 'infra-kit env-token-set staging' },
    ])
  })

  it('reports INFRA_KIT_ENV_TOKEN as covering every env, never leaking its value', async () => {
    vi.stubEnv(INFRA_KIT_ENV_TOKEN_VAR, 'dp.st.from-env.9999zzzz')

    const result = await envList()

    expect(result.structuredContent.tokens).toEqual([
      { env: 'dev', source: 'workflow', hasToken: true },
      { env: 'staging', source: 'workflow', hasToken: true },
    ])
    expect(printed()).not.toContain('9999zzzz')
  })

  it('marks a token-only env (held but declared by no workflow) distinctly in the printed line', async () => {
    vi.mocked(listProjectEnvs).mockResolvedValue([{ env: 'prod_observability', source: 'token-only' }])
    await setToken('prod_observability', DEV_TOKEN)

    const result = await envList()

    expect(result.structuredContent.tokens).toEqual([
      { env: 'prod_observability', source: 'token-only', hasToken: true },
    ])
    expect(printed()).toContain('prod_observability (token set, not in any workflow)')
  })
})

describe('envList — empty state', () => {
  it('prints guidance (never a bare empty list) and still returns cleanly when there are no envs', async () => {
    vi.mocked(listProjectEnvs).mockResolvedValue([])

    const result = await envList()

    expect(result.structuredContent.tokens).toEqual([])

    const output = printed()

    expect(output).toContain('No environments found.')
    expect(output).toContain('workflow_dispatch')
    expect(output).toContain('infra-kit env-token-set <env>')
    // The populated-list header must never appear alongside the empty-state guidance.
    expect(output).not.toContain('Environments:')
  })
})
