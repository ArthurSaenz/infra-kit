import { describe, expect, it } from 'vitest'

import { buildDeployEnv, formatContract } from '../deploy-env'

describe('buildDeployEnv', () => {
  it('sets the three vars the deploy scripts never set themselves', () => {
    // The whole reason this command exists: `_deploy-serverless-jobs.yml` sets these in YAML and no
    // script sets them, so a bare local run builds with them unset.
    const result = buildDeployEnv({ env: 'arthur', branch: 'dev', sha: 'abc123', ambient: {} })

    expect(result.contract).toStrictEqual({
      VITE_DOMAIN_ENV: 'arthur',
      VITE_BRANCH_NAME: 'dev',
      VITE_COMMIT_HASH: 'abc123',
    })
  })

  it('strips ambient VITE_* so a shell value cannot reach the bundle', () => {
    // Builds run `turbo --env-mode=loose` and `turbo.json` declares `build.env: ["VITE_*"]`, so after
    // `infra-kit env-load` a Doppler value would otherwise be baked into a deployed artifact.
    const result = buildDeployEnv({
      env: 'arthur',
      branch: 'dev',
      sha: 'abc123',
      ambient: { VITE_API_KEY: 'from-doppler', VITE_DOMAIN_ENV: 'stale', PATH: '/usr/bin' },
    })

    expect(result.childEnv.VITE_API_KEY).toBeUndefined()
    expect(result.stripped).toStrictEqual(['VITE_API_KEY', 'VITE_DOMAIN_ENV'])
    // Non-VITE vars must survive — the scripts need PATH, AWS creds, HOME.
    expect(result.childEnv.PATH).toBe('/usr/bin')
  })

  it('lets the contract win over a stale ambient VITE_DOMAIN_ENV', () => {
    // The ordering that matters: strip first, then export. If a stale value survived, the artifact
    // would point at the wrong environment while the command reported success.
    const result = buildDeployEnv({
      env: 'arthur',
      branch: 'dev',
      sha: 'abc123',
      ambient: { VITE_DOMAIN_ENV: 'prod' },
    })

    expect(result.childEnv.VITE_DOMAIN_ENV).toBe('arthur')
  })

  it('passes DEPLOY_* through for scripts that later grow their own deploy-env.sh', () => {
    const result = buildDeployEnv({ env: 'dev', branch: 'main', sha: 'deadbeef', ambient: {} })

    expect(result.childEnv.DEPLOY_ENV).toBe('dev')
    expect(result.childEnv.DEPLOY_BRANCH).toBe('main')
    expect(result.childEnv.DEPLOY_SHA).toBe('deadbeef')
  })
})

describe('formatContract', () => {
  it('prints the three contract keys and never the child environment', () => {
    // The child env inherits the caller's shell, where AWS_SECRET_ACCESS_KEY lives.
    const result = buildDeployEnv({
      env: 'arthur',
      branch: 'dev',
      sha: 'abc123',
      ambient: { AWS_SECRET_ACCESS_KEY: 'super-secret', VITE_LEAK: 'also-secret' },
    })

    const printed = formatContract(result)

    expect(printed).toContain('VITE_DOMAIN_ENV')
    expect(printed).not.toContain('super-secret')
    // Stripped vars are named so a surprising build is explainable — but never valued.
    expect(printed).toContain('VITE_LEAK')
    expect(printed).not.toContain('also-secret')
  })
})
