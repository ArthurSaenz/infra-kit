import { afterEach, describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'

import { getProjectVersions } from '../api'
import { JiraApiError, classifyJiraFailure, isJiraApiError } from '../jira-api-error'

const CONFIG = { baseUrl: 'https://acme.atlassian.net', token: 't', email: 'a@b.c', projectId: 11713 }

/** The exact body a live Cloud instance returns for an unbrowsable project (measured). */
const NOT_FOUND_BODY = '{"errorMessages":["No project could be found with id \'11713\'."],"errors":{}}'

const respond = (status: number, body: string, headers: Record<string, string> = {}) => {
  return new Response(body, { status, headers })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('classifyJiraFailure — header first, by value', () => {
  // The whole defect in one row: a dead token yields 404, NOT 401, because Jira refuses to reveal
  // that a project the caller cannot see exists. Classifying on status alone files the single most
  // common failure as "your project id is wrong" — which is what actually happened to an operator.
  it('calls a 404 carrying AUTHENTICATED_FAILED an auth failure, not a missing project', () => {
    expect(classifyJiraFailure(404, 'AUTHENTICATED_FAILED')).toBe('auth')
  })

  it('calls a bare 404 ambiguous, because the header is absent for anonymous AND for malformed auth', () => {
    expect(classifyJiraFailure(404, null)).toBe('not-found-or-forbidden')
  })

  // Presence is conclusive, absence proves nothing — so an unrecognised value must not read as auth.
  it('matches the header value, never its mere presence', () => {
    expect(classifyJiraFailure(404, 'OK')).toBe('not-found-or-forbidden')
  })

  it('treats a bare 401 as auth even with no header', () => {
    expect(classifyJiraFailure(401, null)).toBe('auth')
  })

  it('separates 403 (authenticated, unauthorised) from both', () => {
    expect(classifyJiraFailure(403, null)).toBe('forbidden')
  })

  it('falls through to other on a server fault', () => {
    expect(classifyJiraFailure(500, null)).toBe('other')
  })
})

describe('jiraApiError.message is self-sufficient', () => {
  // entry/cli.ts prints ONLY error.message for an uncaught error. Anything omitted here is invisible.
  it('names the credentials on an auth failure', () => {
    const error = new JiraApiError({
      status: 404,
      seraphLoginReason: 'AUTHENTICATED_FAILED',
      body: NOT_FOUND_BODY,
      context: 'Failed to get Jira project versions',
    })

    expect(error.message).toContain('JIRA_EMAIL')
    expect(error.message).toContain('JIRA_TOKEN')
    expect(isJiraApiError(error)).toBe(true)
  })

  it('states all three readings when a 404 carries no header', () => {
    const message = new JiraApiError({
      status: 404,
      seraphLoginReason: null,
      body: NOT_FOUND_BODY,
      context: 'Failed to get Jira project versions',
    }).message

    expect(message).toContain('JIRA_PROJECT_ID does not exist')
    expect(message).toContain('cannot browse it')
    expect(message).toContain('anonymous')
  })
})

describe('assertJiraOk emits at debug only', () => {
  // The regression: this fired at ERROR, so `worktrees list` — which tolerates the failure and then
  // prints a green ok — painted two red blocks above it. Severity belongs to whoever catches.
  it('logs no error and no warn when the call fails, and throws a classified error', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return respond(404, NOT_FOUND_BODY, { 'x-seraph-loginreason': 'AUTHENTICATED_FAILED' })
      }),
    )

    await expect(getProjectVersions(CONFIG)).rejects.toThrow(JiraApiError)

    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(debugSpy).toHaveBeenCalledTimes(1)
  })

  it('emits exactly once for one fault — the rethrow chain no longer re-logs', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return respond(404, NOT_FOUND_BODY, { 'x-seraph-loginreason': 'AUTHENTICATED_FAILED' })
      }),
    )

    await expect(getProjectVersions(CONFIG)).rejects.toThrow()

    expect(debugSpy).toHaveBeenCalledTimes(1)
  })
})
