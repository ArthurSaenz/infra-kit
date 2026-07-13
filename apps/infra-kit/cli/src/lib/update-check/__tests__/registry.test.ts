import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_REGISTRY, fetchLatestVersion, registryUrl } from '../registry'

const jsonResponse = (body: unknown, ok = true): Response => {
  return {
    ok,
    json: async () => {
      return body
    },
  } as unknown as Response
}

describe('registryUrl', () => {
  it('defaults to the public registry', () => {
    expect(registryUrl({})).toBe(DEFAULT_REGISTRY)
  })

  it('honors a corporate mirror and trims trailing slashes', () => {
    // A user behind a mirror cannot install what registry.npmjs.org reports.
    expect(registryUrl({ npm_config_registry: 'https://nexus.corp/repo/npm/' })).toBe('https://nexus.corp/repo/npm')
  })

  it('ignores an empty override', () => {
    expect(registryUrl({ npm_config_registry: '' })).toBe(DEFAULT_REGISTRY)
  })
})

describe('fetchLatestVersion', () => {
  it('returns the version from the latest dist-tag', async () => {
    // Params are declared so `mock.calls[0]` is a 2-tuple rather than `[]`, which tsc rejects on index.
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => {
      return jsonResponse({ version: '0.1.131' })
    })

    await expect(fetchLatestVersion({}, fetchFn as unknown as typeof fetch)).resolves.toBe('0.1.131')
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${DEFAULT_REGISTRY}/infra-kit/latest`)
  })

  it.each([
    [
      'a non-200 response',
      async () => {
        return jsonResponse({ version: '9.9.9' }, false)
      },
    ],
    [
      'a body with no version',
      async () => {
        return jsonResponse({})
      },
    ],
    [
      'a non-string version',
      async () => {
        return jsonResponse({ version: 42 })
      },
    ],
    [
      'an empty version',
      async () => {
        return jsonResponse({ version: '' })
      },
    ],
    [
      'malformed JSON',
      async () => {
        return {
          ok: true,
          json: async () => {
            throw new SyntaxError('bad')
          },
        } as unknown as Response
      },
    ],
    [
      'a network failure',
      async () => {
        throw new TypeError('offline')
      },
    ],
  ])('returns null for %s rather than throwing', async (_label, fetchFn) => {
    // A failed check must be indistinguishable from "no update available".
    await expect(fetchLatestVersion({}, fetchFn as unknown as typeof fetch)).resolves.toBeNull()
  })

  it('passes an abort signal so a hanging registry cannot pin the detached child open', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => {
      return jsonResponse({ version: '0.1.131' })
    })

    await fetchLatestVersion({}, fetchFn as unknown as typeof fetch)

    const options = fetchFn.mock.calls[0]?.[1] as unknown as { signal: AbortSignal }

    expect(options.signal).toBeInstanceOf(AbortSignal)
  })
})
