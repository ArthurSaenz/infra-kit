import { describe, expect, it } from 'vitest'

describe('sanity check', () => {
  it('should be testable', () => {
    // eslint-disable-next-line sonarjs/no-trivial-assertions -- intentional test-runner sanity check
    expect(1 + 1).toBe(2)
  })
})
