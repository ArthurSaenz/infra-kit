/**
 * @fileoverview
 * Classification of a failed Jira REST response, carried ON the error rather than re-derived.
 *
 * Why this exists: a dead API token makes Jira answer a project-scoped read with `404` and the body
 * "no project could be found with id X" — never `401`, never `403`, because Jira refuses to leak
 * whether a project the caller cannot see exists. Reporting that status verbatim told operators
 * their project ID was wrong when the real fault was an expired token, which is the bug this module
 * closes. The discriminator was on the response all along and simply was not read.
 *
 * Measured against a live Cloud instance (see docs/jira-401-misreported-as-404-plan.md §1.1):
 * `x-seraph-loginreason: AUTHENTICATED_FAILED` is present on every request that supplied
 * credentials Jira rejected, and absent on every anonymous one, on every `200` — including 200s made
 * with the dead token — and on a malformed `Authorization` header. So its PRESENCE IS CONCLUSIVE and
 * its ABSENCE PROVES NOTHING, which is why {@link classifyJiraFailure} matches the header's value and
 * never merely tests that the header is there.
 */

/** What a failed Jira response actually tells us about the cause. */
export type JiraFailureKind = 'auth' | 'forbidden' | 'not-found-or-forbidden' | 'other'

const SERAPH_HEADER = 'x-seraph-loginreason'
const SERAPH_AUTHENTICATION_FAILED = 'AUTHENTICATED_FAILED'

/** First line of an upstream body, capped, so it can ride inside a one-line message. */
const firstLine = (body: string, max = 160): string => {
  const line = body.split('\n', 1)[0]!.trim()

  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * Decide what a non-OK Jira response means.
 *
 * Header first, by value: a rejected credential yields `404 + AUTHENTICATED_FAILED` on the very call
 * this CLI makes, so a status-first classifier would file the common case as "project missing".
 */
export const classifyJiraFailure = (status: number, seraphLoginReason: string | null): JiraFailureKind => {
  if (seraphLoginReason === SERAPH_AUTHENTICATION_FAILED || status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found-or-forbidden'

  return 'other'
}

/** The cause, stated plainly — including the ambiguity we cannot resolve. */
const explain = (kind: JiraFailureKind, status: number): string => {
  if (kind === 'auth') {
    return `Jira rejected the credentials (HTTP ${status}) — check JIRA_EMAIL and JIRA_TOKEN; Atlassian API tokens expire`
  }

  if (kind === 'forbidden') {
    return `Jira authenticated the account but refused the operation (HTTP ${status}) — the account lacks permission on this project`
  }

  if (kind === 'not-found-or-forbidden') {
    return `Jira returned HTTP ${status}: either JIRA_PROJECT_ID does not exist, or these credentials cannot browse it, or the Authorization header was malformed and the request went out anonymous`
  }

  return `Jira returned HTTP ${status}`
}

/**
 * A failed Jira REST call, classified.
 *
 * `message` is deliberately self-sufficient — `entry/cli.ts` prints only `error.message` for an
 * uncaught error, so anything omitted here never reaches the operator.
 */
export class JiraApiError extends Error {
  readonly status: number
  readonly kind: JiraFailureKind
  readonly body: string
  readonly context: string

  constructor(args: { status: number; seraphLoginReason: string | null; body: string; context: string }) {
    const kind = classifyJiraFailure(args.status, args.seraphLoginReason)
    const detail = firstLine(args.body)

    super(
      detail === ''
        ? `${args.context}: ${explain(kind, args.status)}`
        : `${args.context}: ${explain(kind, args.status)}. Jira said: ${detail}`,
    )

    this.name = 'JiraApiError'
    this.status = args.status
    this.kind = kind
    this.body = args.body
    this.context = args.context
  }
}

/** Type guard — classification travels with the error, so callers never grep a message. */
export const isJiraApiError = (error: unknown): error is JiraApiError => {
  return error instanceof JiraApiError
}

/** Read the discriminating header off a response. Exported so `assertJiraOk` stays declarative. */
export const readSeraphLoginReason = (response: Response): string | null => {
  return response.headers.get(SERAPH_HEADER)
}
