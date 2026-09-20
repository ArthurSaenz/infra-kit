import { afterEach, describe, expect, it, vi } from 'vitest'

import { createJiraVersion, updateJiraVersion } from '../api'

/**
 * The request bodies `release create` / `release edit` put on the wire for a fix version's
 * `releaseDate`, and the one place a 200 is not trusted: a clear that Jira acknowledged but did not
 * perform. `fetch` is stubbed per test; `assertJiraOk` stays real.
 */

const CONFIG = { baseUrl: 'https://acme.atlassian.net', token: 't', email: 'a@b.c', projectId: 11713 }

// Params declared so `mock.calls[0]` is a 2-tuple rather than `[]` (see remove-version.test.ts).
const fetchEchoing = (echo: Record<string, unknown>) => {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify(echo), { status: 200 })
  })
}

const sentBody = (fetchSpy: ReturnType<typeof fetchEchoing>): Record<string, unknown> => {
  const [, init] = fetchSpy.mock.calls[0]!

  return JSON.parse(init?.body as string) as Record<string, unknown>
}

const version = (overrides: Record<string, unknown> = {}) => {
  return { id: '42', self: 'x', name: 'v1.2.3', archived: false, released: false, projectId: 11713, ...overrides }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createJiraVersion — POST body', () => {
  const base = { name: 'v1.2.3', projectId: 11713 }

  // Byte-identical to the pre-date body: an agent parsing the outbound shape, or a Jira tenant that
  // rejects unknown keys, sees no change when no date was given.
  it('carries no releaseDate key when none is given', async () => {
    const fetchSpy = fetchEchoing(version())

    vi.stubGlobal('fetch', fetchSpy)
    await createJiraVersion(base, CONFIG)

    expect(sentBody(fetchSpy)).toStrictEqual({
      name: 'v1.2.3',
      projectId: 11713,
      description: '',
      released: false,
      archived: false,
    })
  })

  it('carries releaseDate when given', async () => {
    const fetchSpy = fetchEchoing(version({ releaseDate: '2026-10-28' }))

    vi.stubGlobal('fetch', fetchSpy)
    await createJiraVersion({ ...base, releaseDate: '2026-10-28' }, CONFIG)

    expect(sentBody(fetchSpy)).toMatchObject({ releaseDate: '2026-10-28' })
  })
})

describe('updateJiraVersion — the clear intent', () => {
  it('sends releaseDate: null for a clear', async () => {
    const fetchSpy = fetchEchoing(version())

    vi.stubGlobal('fetch', fetchSpy)
    await updateJiraVersion({ versionId: '42', releaseDate: null }, CONFIG)

    expect(sentBody(fetchSpy)).toStrictEqual({ releaseDate: null })
  })

  it('leaves releaseDate out when the caller did not pass it', async () => {
    const fetchSpy = fetchEchoing(version())

    vi.stubGlobal('fetch', fetchSpy)
    await updateJiraVersion({ versionId: '42', description: 'd' }, CONFIG)

    expect(sentBody(fetchSpy)).toStrictEqual({ description: 'd' })
  })

  // A 200 with the old date still in the echo is the one outcome that would otherwise pass silently.
  it('throws, saying the write happened, when the echo of a clear still carries a date', async () => {
    vi.stubGlobal('fetch', fetchEchoing(version({ releaseDate: '2026-10-28' })))

    await expect(updateJiraVersion({ versionId: '42', releaseDate: null }, CONFIG)).rejects.toThrow(
      /the write happened.*releaseDate=2026-10-28/,
    )
  })

  it('accepts an echo whose date is the empty string as cleared', async () => {
    vi.stubGlobal('fetch', fetchEchoing(version({ releaseDate: '' })))

    await expect(updateJiraVersion({ versionId: '42', releaseDate: null }, CONFIG)).resolves.toMatchObject({
      success: true,
    })
  })

  // Proves the comparison never enters the deliver path: `deliverJiraRelease` PUTs
  // `released: true, releaseDate: today`, and Jira normalising the echo must not read as a failure.
  it('does not compare the echo on a set (deliver-shaped PUT)', async () => {
    vi.stubGlobal('fetch', fetchEchoing(version({ released: true, releaseDate: '28/Oct/26' })))

    await expect(
      updateJiraVersion({ versionId: '42', released: true, releaseDate: '2026-10-28' }, CONFIG),
    ).resolves.toMatchObject({ success: true })
  })
})
