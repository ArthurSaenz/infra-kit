import { afterEach, describe, expect, it, vi } from 'vitest'

import { createJiraVersion, findVersionById, getMyJiraPermissions, updateJiraVersion } from '../api'

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

describe('updateJiraVersion — name', () => {
  it('sends the name when given', async () => {
    const fetchSpy = fetchEchoing(version({ name: 'v2.0.0' }))

    vi.stubGlobal('fetch', fetchSpy)

    await updateJiraVersion({ versionId: '42', name: 'v2.0.0' }, CONFIG)

    expect(sentBody(fetchSpy)).toEqual({ name: 'v2.0.0' })
  })

  it('sends no name key when omitted, so the update stays partial', async () => {
    const fetchSpy = fetchEchoing(version())

    vi.stubGlobal('fetch', fetchSpy)

    await updateJiraVersion({ versionId: '42', description: 'd' }, CONFIG)

    expect(sentBody(fetchSpy)).toEqual({ description: 'd' })
  })

  it('throws when Jira echoes a different name', async () => {
    vi.stubGlobal('fetch', fetchEchoing(version({ name: 'v1.2.3' })))

    await expect(updateJiraVersion({ versionId: '42', name: 'v2.0.0' }, CONFIG)).rejects.toThrow(/v1\.2\.3.*v2\.0\.0/)
  })

  it('does not compare names when none was requested', async () => {
    vi.stubGlobal('fetch', fetchEchoing(version({ name: 'anything' })))

    await expect(updateJiraVersion({ versionId: '42', released: true }, CONFIG)).resolves.toMatchObject({
      success: true,
    })
  })
})

describe('findVersionById', () => {
  const versions = [version({ id: '41', name: 'v1.2.2' }), version({ id: '42', name: 'v1.2.3' })]

  it('returns the version with that id', async () => {
    vi.stubGlobal('fetch', fetchEchoing(versions as unknown as Record<string, unknown>))

    await expect(findVersionById('42', CONFIG)).resolves.toMatchObject({ name: 'v1.2.3' })
  })

  it('returns null when no version has that id', async () => {
    vi.stubGlobal('fetch', fetchEchoing(versions as unknown as Record<string, unknown>))

    await expect(findVersionById('99', CONFIG)).resolves.toBeNull()
  })
})

describe('getMyJiraPermissions', () => {
  it('queries mypermissions for the project and maps granted, denied and missing keys', async () => {
    const fetchSpy = fetchEchoing({
      permissions: {
        ADMINISTER_PROJECTS: { havePermission: true },
        ADMINISTER: { havePermission: false },
      },
    })

    vi.stubGlobal('fetch', fetchSpy)

    const result = await getMyJiraPermissions(CONFIG, ['ADMINISTER_PROJECTS', 'ADMINISTER', 'OTHER'])

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'https://acme.atlassian.net/rest/api/3/mypermissions?projectId=11713&permissions=ADMINISTER_PROJECTS,ADMINISTER,OTHER',
    )
    expect(result).toEqual({ ADMINISTER_PROJECTS: true, ADMINISTER: false, OTHER: false })
  })

  it('treats a response without a permissions object as all denied', async () => {
    vi.stubGlobal('fetch', fetchEchoing({}))

    await expect(getMyJiraPermissions(CONFIG, ['ADMINISTER'])).resolves.toEqual({ ADMINISTER: false })
  })
})
