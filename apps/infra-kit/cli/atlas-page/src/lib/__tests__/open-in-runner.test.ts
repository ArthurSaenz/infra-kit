import { describe, expect, it, vi } from 'vitest'

import { openInRunner } from '../open-in-runner'

const respond = (ok: boolean) => {
  return vi.fn(async () => {
    return { ok } as Response
  })
}

describe('openInRunner', () => {
  it('posts the id to the open route and reports the runner opened it', async () => {
    const post = respond(true)

    expect(await openInRunner('shop/ui', post)).toBe(true)
    expect(post).toHaveBeenCalledWith('/__atlas/open', { id: 'shop/ui' })
  })

  it('reports false when the runner cannot open it, so the caller follows the link', async () => {
    expect(await openInRunner('shop/ui', respond(false))).toBe(false)
  })

  it('reports false when the request itself fails', async () => {
    const post = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    expect(await openInRunner('shop/ui', post)).toBe(false)
  })
})
