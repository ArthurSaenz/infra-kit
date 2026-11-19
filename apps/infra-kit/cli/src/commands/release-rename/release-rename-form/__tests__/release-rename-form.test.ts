import { describe, expect, it } from 'vitest'

import { createReleaseRenameFormProvider } from '../release-rename-form'

describe('createReleaseRenameFormProvider', () => {
  const provider = createReleaseRenameFormProvider()

  it('is formable only while <old> is missing or blank', () => {
    expect(provider.isFormable({})).toBe(true)
    expect(provider.isFormable({ old: '' })).toBe(true)
    expect(provider.isFormable({ old: '1.2.3' })).toBe(false)
    expect(provider.isFormable(null)).toBe(false)
  })

  it('merges the picked fields over round 1', () => {
    expect(provider.toArgs({ old: '1.2.3', new: '1.3.0' }, { confirm: true })).toEqual({
      confirm: true,
      old: '1.2.3',
      new: '1.3.0',
    })
    expect(provider.toArgs({ old: '1.2.3', new: '' }, { new: 'kept' })).toEqual({ old: '1.2.3', new: 'kept' })
    expect(provider.toArgs({}, {})).toBeNull()
  })
})
