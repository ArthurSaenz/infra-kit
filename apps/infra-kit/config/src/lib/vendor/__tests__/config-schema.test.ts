import { describe, expect, it } from 'vitest'

import { vendorCopyItemSchema } from '../config-schema'

const base = { name: 'Configs', type: 'directory' as const }

describe('vendorCopyItemSchema — safeRelPath containment', () => {
  it('accepts a normal repo-relative path', () => {
    const result = vendorCopyItemSchema.safeParse({ ...base, source: 'vendor/configs', target: 'vendor/configs' })

    expect(result.success).toBe(true)
  })

  it('rejects a target that escapes the repo root with ".."', () => {
    const result = vendorCopyItemSchema.safeParse({ ...base, source: 'vendor/configs', target: '../escape' })

    expect(result.success).toBe(false)
  })

  it('rejects an absolute source path', () => {
    const result = vendorCopyItemSchema.safeParse({ ...base, source: '/etc/passwd', target: 'vendor/configs' })

    expect(result.success).toBe(false)
  })

  it('rejects an empty path', () => {
    const result = vendorCopyItemSchema.safeParse({ ...base, source: '', target: 'vendor/configs' })

    expect(result.success).toBe(false)
  })
})
