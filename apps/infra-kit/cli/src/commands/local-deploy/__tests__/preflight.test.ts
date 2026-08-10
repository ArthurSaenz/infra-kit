import { describe, expect, it } from 'vitest'

import { isSharedEnv } from '../local-deploy'
import {
  assertCleanTreeForSharedEnv,
  assertEnvMatchesAccount,
  assertNoCiDeployInFlight,
  runPreflight,
} from '../preflight'
import type { SkippableCheck } from '../preflight'

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

// `isShared` is the input to the dirty-tree refusal as well as the prompt, so how it is RESOLVED is
// the thing worth testing. Passing `isShared: true` into `assertCleanTreeForSharedEnv` above proves
// only that the leaf works — it hand-passes the value under test and would stay green with `prod`
// resolving to false, which is exactly the bug this guards.
describe('isSharedEnv', () => {
  it('treats a protected env as shared even though SHARED_ENVS omits it', () => {
    expect(isSharedEnv('prod')).toBe(true)
  })

  it('still treats the listed team environments as shared', () => {
    expect(isSharedEnv('dev')).toBe(true)
    expect(isSharedEnv('stage')).toBe(true)
  })

  it('leaves a personal environment unshared — deploying WIP there is the point', () => {
    expect(isSharedEnv('arthur')).toBe(false)
  })
})

// runPreflight itself had no coverage: only its three leaf asserts did. These all refuse before
// `resolveAccountIdentity`, so they need no AWS.
describe('runPreflight', () => {
  const baseArgs = {
    project: 'p',
    isShared: true,
    isClean: true,
    runningEnvs: [] as string[],
    skip: [] as SkippableCheck[],
  }

  it('refuses a protected env when the project has not allowed it', async () => {
    await expect(runPreflight({ ...baseArgs, env: 'prod' })).rejects.toThrow(/delivered, not deployed/)
  })

  it('refuses a protected env over MCP when the project allows it CLI-only', async () => {
    await expect(
      runPreflight({ ...baseArgs, env: 'prod', protectedEnvAccess: { allowed: false, reason: 'mcp-blocked' } }),
    ).rejects.toThrow(/cli-only/)
  })

  // The unattended-prod-deploy hole: `--env prod --yes --skip-preflight clean-tree` would otherwise
  // ship whatever is in the working tree, with no prompt and no check.
  it('refuses to waive clean-tree for a protected env even when the project allows it', async () => {
    await expect(
      runPreflight({
        ...baseArgs,
        env: 'prod',
        isClean: false,
        skip: ['clean-tree'],
        protectedEnvAccess: { allowed: true, reason: 'allowed' },
      }),
    ).rejects.toThrow(/refusing to skip the clean-tree check/)
  })

  it('still honours a clean-tree waiver for an ordinary env', async () => {
    // Reaches the AWS lookup, which is the proof it got past every gate above it.
    await expect(
      runPreflight({ ...baseArgs, env: 'arthur', isShared: false, isClean: false, skip: ['clean-tree'] }),
    ).rejects.not.toThrow(/clean-tree|uncommitted/)
  })

  it('refuses a dirty tree against an allowed protected env', async () => {
    await expect(
      runPreflight({
        ...baseArgs,
        env: 'prod',
        isClean: false,
        protectedEnvAccess: { allowed: true, reason: 'allowed' },
      }),
    ).rejects.toThrow(/uncommitted changes/)
  })
})
