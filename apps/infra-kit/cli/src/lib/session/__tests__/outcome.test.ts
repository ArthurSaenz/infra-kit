import { describe, expect, it } from 'vitest'

import { classifyOutcome } from '../outcome'

describe('classifyOutcome', () => {
  it('report present + exit 0 => ok', () => {
    expect(classifyOutcome(0, null, true)).toBe('ok')
  })

  it('report present + exit 1 => findings', () => {
    expect(classifyOutcome(1, null, true)).toBe('findings')
  })

  it('report present + SIGINT => ok (teardown after the report was written)', () => {
    expect(classifyOutcome(null, 'SIGINT', true)).toBe('ok')
  })

  it('report absent + exit 1 => failed', () => {
    expect(classifyOutcome(1, null, false)).toBe('failed')
  })

  it('report absent + exit 0 => cancelled', () => {
    expect(classifyOutcome(0, null, false)).toBe('cancelled')
  })

  it('report absent + SIGINT => cancelled', () => {
    expect(classifyOutcome(null, 'SIGINT', false)).toBe('cancelled')
  })
})
