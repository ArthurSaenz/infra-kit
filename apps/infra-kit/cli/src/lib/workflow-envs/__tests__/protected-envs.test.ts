import { describe, expect, it } from 'vitest'

import { OperationError } from 'src/lib/errors/operation-error'

import { PROTECTED_ENVS, assertDeployable, deployableEnvs, isProtectedEnv } from '../protected-envs'

describe('pROTECTED_ENVS / isProtectedEnv', () => {
  it('is exactly [prod]', () => {
    expect(PROTECTED_ENVS).toEqual(['prod'])
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
