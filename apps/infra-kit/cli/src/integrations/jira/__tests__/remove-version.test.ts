import { afterEach, describe, expect, it, vi } from 'vitest'

import { JiraApiError } from '../jira-api-error'
import { getVersionRelatedIssueCounts, removeJiraVersion } from '../remove-version'

/**
 * The false-success this test prevents: a hand-rolled second classifier in this leaf module reading
 * a rejected-credential 404 as "version not found" instead of "auth failed".
 *
 * That is the exact misreport this repo already fixed once for the rest of the Jira integration
 * (`docs/jira-401-misreported-as-404-plan.md`). `removeJiraVersion` imports `assertJiraOk` from the
 * leaf `api.ts` module rather than re-deriving a classification, so that fix carries over
 * automatically; this test pins that it actually does.
 *
 * `fetch` is stubbed per test; `assertJiraOk` and `classifyJiraFailure` stay real.
 */

const CONFIG = { baseUrl: 'https://acme.atlassian.net', token: 't', email: 'a@b.c', projectId: 11713 }

const respond = (status: number, body: string, headers: Record<string, string> = {}) => {
  return new Response(body, { status, headers })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('removeJiraVersion — classification', () => {
  it('classifies a 404 carrying AUTHENTICATED_FAILED as auth, not not-found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return respond(404, '{"errorMessages":["No version could be found with id \'10001\'."],"errors":{}}', {
          'x-seraph-loginreason': 'AUTHENTICATED_FAILED',
        })
      }),
    )

    let thrown: unknown

    try {
      await removeJiraVersion({ versionId: '10001' }, CONFIG)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(JiraApiError)
    expect((thrown as JiraApiError).kind).toBe('auth')
  })
})

// Params are declared on every fetch spy in this block so `mock.calls[0]` is a 2-tuple rather than
// `[]`, which tsc otherwise rejects on index (see src/lib/update-check/__tests__/registry.test.ts:38).
const fetchSpyReturning = (status: number, body: string) => {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    return respond(status, body)
  })
}

describe('removeJiraVersion — request shape', () => {
  it('posts to removeAndSwap with Basic auth and no move* fields when none are supplied', async () => {
    const fetchSpy = fetchSpyReturning(200, '{}')

    vi.stubGlobal('fetch', fetchSpy)

    await removeJiraVersion({ versionId: '10001' }, CONFIG)

    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const [url, init] = fetchSpy.mock.calls[0]!

    expect(url).toBe('https://acme.atlassian.net/rest/api/3/version/10001/removeAndSwap')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('a@b.c:t')}`)
    expect(JSON.parse(init?.body as string)).toEqual({})
  })

  it('includes each move* field only when the caller supplies it', async () => {
    const fetchSpy = fetchSpyReturning(200, '{}')

    vi.stubGlobal('fetch', fetchSpy)

    await removeJiraVersion({ versionId: '10001', moveFixIssuesTo: '10002' }, CONFIG)

    const [, fixOnlyInit] = fetchSpy.mock.calls[0]!

    expect(JSON.parse(fixOnlyInit?.body as string)).toEqual({ moveFixIssuesTo: '10002' })

    await removeJiraVersion({ versionId: '10001', moveAffectedIssuesTo: '10003' }, CONFIG)

    const [, affectedOnlyInit] = fetchSpy.mock.calls[1]!

    expect(JSON.parse(affectedOnlyInit?.body as string)).toEqual({ moveAffectedIssuesTo: '10003' })

    await removeJiraVersion({ versionId: '10001', moveFixIssuesTo: '10002', moveAffectedIssuesTo: '10003' }, CONFIG)

    const [, bothInit] = fetchSpy.mock.calls[2]!

    expect(JSON.parse(bothInit?.body as string)).toEqual({ moveFixIssuesTo: '10002', moveAffectedIssuesTo: '10003' })
  })
})

describe('getVersionRelatedIssueCounts', () => {
  it('parses both counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return respond(200, JSON.stringify({ issuesFixedCount: 21, issuesAffectedCount: 2 }))
      }),
    )

    await expect(getVersionRelatedIssueCounts('10001', CONFIG)).resolves.toEqual({
      issuesFixedCount: 21,
      issuesAffectedCount: 2,
    })
  })
})
