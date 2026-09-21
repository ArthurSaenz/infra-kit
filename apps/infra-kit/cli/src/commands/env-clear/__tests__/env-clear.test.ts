import { describe, expect, it } from 'vitest'

import { buildEnvClearLines } from '../env-clear'

describe('buildEnvClearLines', () => {
  it('unsets every loaded var name passed in', () => {
    const lines = buildEnvClearLines(['FOO', 'BAR'])

    expect(lines).toContain('unset FOO')
    expect(lines).toContain('unset BAR')
  })

  it('unsets the session metadata vars', () => {
    const lines = buildEnvClearLines([])

    expect(lines).toContain('unset INFRA_KIT_ENV')
    expect(lines).toContain('unset INFRA_KIT_ENV_CONFIG')
    expect(lines).toContain('unset INFRA_KIT_ENV_PROJECT')
    expect(lines).toContain('unset INFRA_KIT_ENV_LOADED_AT')
  })

  it('only unsets — nothing is exported into the shell that sources it', () => {
    const lines = buildEnvClearLines(['FOO'])

    expect(
      lines.every((line) => {
        return line.startsWith('unset ')
      }),
    ).toBe(true)
  })
})
