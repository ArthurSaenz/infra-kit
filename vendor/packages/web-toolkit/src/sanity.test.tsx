import { describe, expect, it } from 'vitest'

describe('sanity check', () => {
  it('should be testable', () => {
    expect(Math.max(1, 2)).toBe(2)
  })
})
