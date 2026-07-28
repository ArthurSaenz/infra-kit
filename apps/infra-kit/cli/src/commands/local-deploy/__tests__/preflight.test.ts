import { describe, expect, it } from 'vitest'

import { assertCleanTreeForSharedEnv, assertEnvMatchesAccount, assertNoCiDeployInFlight } from '../preflight'

describe('assertEnvMatchesAccount', () => {
  it('refuses when the account is a different environment than the one asked for', () => {
    // The check that makes a laptop deploy safe: credentials come from the shell, so a stale
    // AWS_PROFILE is the ordinary way to ship to the wrong place.
    expect(() => {
      return assertEnvMatchesAccount('arthur', { accountId: '111122223333', stage: 'prod' })
    }).toThrow(/asked for "arthur".*111122223333.*"prod"/s)
  })

  it('passes when intent and account agree', () => {
    expect(() => {
      return assertEnvMatchesAccount('arthur', { accountId: '111122223333', stage: 'arthur' })
    }).not.toThrow()
  })

  it('refuses on a blank stage rather than treating it as a match', () => {
    // An account with no /{project}/environment is exactly the "pointed somewhere unexpected" case.
    expect(() => {
      return assertEnvMatchesAccount('arthur', { accountId: '111122223333', stage: '' })
    }).toThrow()
  })
})

describe('assertCleanTreeForSharedEnv', () => {
  it('refuses a dirty tree against a shared environment', () => {
    expect(() => {
      return assertCleanTreeForSharedEnv({ env: 'dev', isShared: true, isClean: false })
    }).toThrow(/uncommitted changes/)
  })

  it('allows a dirty tree against a personal environment', () => {
    // Deploying work-in-progress to your own env is the point of having one.
    expect(() => {
      return assertCleanTreeForSharedEnv({ env: 'arthur', isShared: false, isClean: false })
    }).not.toThrow()
  })

  it('allows a clean tree against a shared environment', () => {
    expect(() => {
      return assertCleanTreeForSharedEnv({ env: 'dev', isShared: true, isClean: true })
    }).not.toThrow()
  })
})

describe('assertNoCiDeployInFlight', () => {
  it('refuses when CI is already deploying the same environment', () => {
    // A local deploy is invisible to the workflow's concurrency group, so nothing else stops them
    // interleaving: an S3 sync racing a CloudFront invalidation leaves a half-updated bundle.
    expect(() => {
      return assertNoCiDeployInFlight('dev', ['dev'])
    }).toThrow(/already in flight/)
  })

  it('allows when CI is deploying a different environment', () => {
    expect(() => {
      return assertNoCiDeployInFlight('arthur', ['dev'])
    }).not.toThrow()
  })

  it('allows when gh could not answer', () => {
    // Race guard, not a security control — refusing because an optional tool is missing would be
    // worse than the race it prevents.
    expect(() => {
      return assertNoCiDeployInFlight('dev', [])
    }).not.toThrow()
  })
})
