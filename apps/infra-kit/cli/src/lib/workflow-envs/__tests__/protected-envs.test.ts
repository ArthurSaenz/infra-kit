import { describe, expect, it } from 'vitest'

import { OperationError } from 'src/lib/errors/operation-error'

import { DEFAULT_PROTECTED_ENVS, assertDeployable, deployableEnvs, isProtectedEnv } from '../protected-envs'

describe('dEFAULT_PROTECTED_ENVS / isProtectedEnv', () => {
  it('is exactly [prod]', () => {
    expect(DEFAULT_PROTECTED_ENVS).toEqual(['prod'])
  })

  it('flags prod as protected', () => {
    expect(isProtectedEnv('prod')).toBe(true)
  })

  it('does not flag stage or dev as protected', () => {
    expect(isProtectedEnv('stage')).toBe(false)
    expect(isProtectedEnv('dev')).toBe(false)
  })
})

describe('deployableEnvs', () => {
  it('strips prod and keeps stage/dev', () => {
    expect(deployableEnvs(['dev', 'stage', 'prod'])).toEqual(['dev', 'stage'])
  })

  it('is a no-op when prod is absent', () => {
    expect(deployableEnvs(['dev', 'arthur', 'stage'])).toEqual(['dev', 'arthur', 'stage'])
  })

  it('returns [] for []', () => {
    expect(deployableEnvs([])).toEqual([])
  })
})

describe('assertDeployable', () => {
  // The fix must name a command the CLI ACTUALLY accepts. The first version of this message said
  // `gh-release-deliver`, which is not a command on this branch (the flat aliases were dropped) — and
  // this test passed anyway, because it asserted the same wrong string the code emitted. Assert the
  // real invocation, so a rename breaks the test instead of quietly shipping a dead instruction.
  it('throws an OperationError for prod, naming `infra-kit release deliver` as the fix', () => {
    expect(() => {
      assertDeployable('prod', 'launch deploy-all workflow')
    }).toThrow(OperationError)

    expect(() => {
      assertDeployable('prod', 'launch deploy-all workflow')
    }).toThrow(/infra-kit release deliver/)
  })

  it('does not throw for dev', () => {
    expect(() => {
      assertDeployable('dev', 'launch deploy-all workflow')
    }).not.toThrow()
  })

  it('does not throw for stage (deliberately not protected)', () => {
    expect(() => {
      assertDeployable('stage', 'launch deploy-all workflow')
    }).not.toThrow()
  })
})

// The safety property of this module is the DEFAULTED parameter: a call site that forgets to thread
// the resolved access must refuse, not permit. Asserted on its own rather than left as a side effect
// of the tests above, so deleting the default breaks a test that says why it existed.
describe('fail-closed by omission', () => {
  it('refuses a protected env when no access argument is passed at all', () => {
    expect(() => {
      assertDeployable('prod', 'launch deploy-all workflow')
    }).toThrow(OperationError)

    expect(deployableEnvs(['dev', 'prod'])).toEqual(['dev'])
  })
})

describe('with project access granted', () => {
  const allowed = { allowed: true, reason: 'allowed' } as const

  it('keeps prod in the picker', () => {
    expect(deployableEnvs(['dev', 'stage', 'prod'], allowed)).toEqual(['dev', 'stage', 'prod'])
  })

  it('does not throw for prod', () => {
    expect(() => {
      assertDeployable('prod', 'launch deploy-all workflow', allowed)
    }).not.toThrow()
  })
})

describe('with access withheld from agents (cli-only)', () => {
  const mcpBlocked = { allowed: false, reason: 'mcp-blocked' } as const

  // The whole reason `reason` exists. Under a bare boolean this case would emit the delivery message
  // and send an agent off to run `release deliver` — the one flow it must NOT reach — or to report
  // that prod is unconfigured, when in fact the project allows it on the CLI.
  it('names the CLI as the fix and NOT the delivery flow', () => {
    expect(() => {
      assertDeployable('prod', 'launch deploy-all workflow', mcpBlocked)
    }).toThrow(/cli-only/)

    expect(() => {
      assertDeployable('prod', 'launch deploy-all workflow', mcpBlocked)
    }).not.toThrow(/release deliver/)
  })

  it('still strips prod from the picker', () => {
    expect(deployableEnvs(['dev', 'prod'], mcpBlocked)).toEqual(['dev'])
  })
})
