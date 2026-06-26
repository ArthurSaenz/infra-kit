import { describe, expect, it } from 'vitest'

import { buildEnvClearLines } from '../env-clear'

describe('buildEnvClearLines', () => {
  it('unsets every loaded var name passed in', () => {
    const lines = buildEnvClearLines(['FOO', 'BAR'])

    expect(lines).toContain('unset FOO')
    expect(lines).toContain('unset BAR')
  })

  it('unsets the session metadata vars and the auto-load marker', () => {
    const lines = buildEnvClearLines([])

    expect(lines).toContain('unset INFRA_KIT_ENV_CONFIG')
    expect(lines).toContain('unset INFRA_KIT_ENV_PROJECT')
    expect(lines).toContain('unset INFRA_KIT_ENV_LOADED_AT')
    expect(lines).toContain('unset INFRA_KIT_ENV_AUTOLOADED')
  })

  it('exports the clear sentinel so cli-invocation auto-load stays suppressed', () => {
    const lines = buildEnvClearLines([])

    expect(lines).toContain("export INFRA_KIT_ENV_CLEARED='1'")
  })
})
