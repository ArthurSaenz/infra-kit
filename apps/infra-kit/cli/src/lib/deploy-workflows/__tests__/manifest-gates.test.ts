import { describe, expect, it } from 'vitest'

import { manifestGates } from '../manifest-gates'

describe('manifestGates', () => {
  const environments: [string, ...string[]] = ['dev', 'arthur', 'stage']

  it('takes envs as given, prod included, and leaves an ungated service out', () => {
    const gates = manifestGates({ environments, services: { mobile: { envs: ['dev', 'prod'] }, 'client-be': {} } })

    expect(Object.fromEntries(gates)).toEqual({ mobile: ['dev', 'prod'] })
  })

  it('resolves skipEnvs against the offered environments', () => {
    const gates = manifestGates({
      environments,
      services: { 'docs-fe': { skipEnvs: ['stage', 'prod'] }, seo: { skipEnvs: ['prod'] } },
    })

    expect(Object.fromEntries(gates)).toEqual({ 'docs-fe': ['dev', 'arthur'] })
  })
})
