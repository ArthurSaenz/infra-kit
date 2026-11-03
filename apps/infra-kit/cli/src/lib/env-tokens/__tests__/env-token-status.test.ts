import { describe, expect, it } from 'vitest'

import { buildEnvTokenStatus } from '../env-token-status'

describe('buildEnvTokenStatus', () => {
  it('reports hasToken from the store, present or absent, without any fix hint', () => {
    expect(
      buildEnvTokenStatus(
        [
          { env: 'dev', source: 'gh-workflow' },
          { env: 'prod', source: 'gh-workflow' },
        ],
        { dev: 'dp.st.dev.xxxx' },
        undefined,
      ),
    ).toEqual([
      { env: 'dev', source: 'gh-workflow', hasToken: true },
      { env: 'prod', source: 'gh-workflow', hasToken: false },
    ])
  })

  it('treats INFRA_KIT_ENV_TOKEN as covering every env, same as resolveEnvToken precedence', () => {
    expect(
      buildEnvTokenStatus(
        [
          { env: 'dev', source: 'gh-workflow' },
          { env: 'prod', source: 'token-only' },
        ],
        {},
        'dp.st.from-env.xxxx',
      ),
    ).toEqual([
      { env: 'dev', source: 'gh-workflow', hasToken: true },
      { env: 'prod', source: 'token-only', hasToken: true },
    ])
  })

  it('carries the source through unchanged (gh-workflow vs token-only)', () => {
    expect(buildEnvTokenStatus([{ env: 'prod_observability', source: 'token-only' }], {}, undefined)).toEqual([
      {
        env: 'prod_observability',
        source: 'token-only',
        hasToken: false,
      },
    ])
  })
})
