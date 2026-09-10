import { assertJiraOk } from './api.js'
import type { JiraConfig } from './types.js'

/**
 * @fileoverview
 * A separate leaf module from `api.ts` on purpose. Tests mock a single module without a barrel
 * partial-mock dropping siblings it does not name — the hazard commented at
 * `src/commands/gh-release-deliver/gh-release-deliver.ts:8-12`.
 *
 * UNVERIFIED — no live Jira instance was available while writing this module. Three claims this file
 * depends on, each with the measurement that would settle it. None of the below has been observed;
 * treat this block as a record of what is assumed, not what was measured.
 *
 * U1. `POST /version/{id}/removeAndSwap` deletes the version, and an empty body means "delete it and
 *     unset the field from every issue that carried it". Settle by: against a throwaway version with
 *     one issue carrying it as `fixVersion`, POST an empty body, then re-fetch that issue and check
 *     its `fixVersions` no longer contains the version. The post-state of the issue is the thing to
 *     check — a *semantic* surprise here (e.g. the swap being permissive in an unexpected direction)
 *     is worse than an HTTP error, because it fails silently for the operator.
 * U2. `GET /version/{id}/relatedIssueCounts` exists and returns `issuesFixedCount` and
 *     `issuesAffectedCount`. Settle by: GET it against a version with a known, differing number of
 *     issues in each role and compare against a manual count. FALLBACK if false:
 *     `GET /search?jql=fixVersion={id}` and read `total`. That fallback is a redesign, not a
 *     swap — a different endpoint, a different permission scope, and one number instead of two — so
 *     with it in play `moveAffectedIssuesTo` cannot be distinguished from `moveFixIssuesTo` and the
 *     caller must refuse the move rather than guess which count it is reassigning.
 * U3. Plain `DELETE /version/{id}` is deprecated in favour of `removeAndSwap`. Settle by: reading the
 *     endpoint's deprecation notice, or attempting the call and checking for a deprecation header on
 *     the response.
 */

/** Both fields returned by `GET /version/{id}/relatedIssueCounts` (U2, unverified). */
export interface JiraVersionIssueCounts {
  issuesFixedCount: number
  issuesAffectedCount: number
}

export const getVersionRelatedIssueCounts = async (
  versionId: string,
  config: JiraConfig,
): Promise<JiraVersionIssueCounts> => {
  const { baseUrl, token, email } = config
  const url = `${baseUrl}/rest/api/3/version/${versionId}/relatedIssueCounts`
  const credentials = btoa(`${email}:${token}`)

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${credentials}`,
    },
  })

  await assertJiraOk(response, 'Failed to get Jira version issue counts')

  const counts = (await response.json()) as JiraVersionIssueCounts

  return {
    issuesFixedCount: counts.issuesFixedCount,
    issuesAffectedCount: counts.issuesAffectedCount,
  }
}

export interface RemoveJiraVersionParams {
  versionId: string
  moveFixIssuesTo?: string
  moveAffectedIssuesTo?: string
}

export const removeJiraVersion = async (params: RemoveJiraVersionParams, config: JiraConfig): Promise<void> => {
  const { baseUrl, token, email } = config

  // Only the fields the caller explicitly passed — an unconditional `undefined` field changes what
  // Jira does with the swap (U1).
  const requestBody: Record<string, string> = {}

  if (params.moveFixIssuesTo !== undefined) requestBody.moveFixIssuesTo = params.moveFixIssuesTo
  if (params.moveAffectedIssuesTo !== undefined) requestBody.moveAffectedIssuesTo = params.moveAffectedIssuesTo

  const url = `${baseUrl}/rest/api/3/version/${params.versionId}/removeAndSwap`
  const credentials = btoa(`${email}:${token}`)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${credentials}`,
    },
    body: JSON.stringify(requestBody),
  })

  await assertJiraOk(response, 'Failed to remove Jira version')
}
