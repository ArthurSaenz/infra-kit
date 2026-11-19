import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'

type PRState = 'OPEN' | 'MERGED' | 'CLOSED'

const DEFAULT_PR_FIELDS = 'number,state,title,baseRefName,headRefName'

export interface PRStatus {
  number: number
  state: PRState
  title: string
  baseRefName: string
  headRefName: string
}

/**
 * Fetch the (most-recent) PR for the given head branch, across all states, so
 * we can resume a partially-completed delivery: a PR merged on a prior attempt
 * still appears here as `state: 'MERGED'`, letting the caller skip the merge.
 */
export const fetchPRByHead = async (head: string): Promise<PRStatus | null> => {
  const result =
    await $`gh pr list --head ${head} --state all --json number,state,title,baseRefName,headRefName --limit 1`

  const prs = JSON.parse(result.stdout) as PRStatus[]

  return prs[0] ?? null
}

/**
 * Every open PR on a head. GitHub allows one open PR per head/base *pair*, so a release branch
 * can carry an open PR to `dev` and another to `main` at once; a caller about to merge has to see
 * both to refuse, where `fetchPRByHead` would hand it whichever gh orders first.
 */
export const fetchOpenPRsByHead = async (head: string, fields: string = DEFAULT_PR_FIELDS): Promise<PRStatus[]> => {
  const result = await $`gh pr list --head ${head} --state open --limit 5 --json ${fields}`

  return JSON.parse(result.stdout) as PRStatus[]
}

/**
 * Re-probe one PR by number right before acting on it: a head-based lookup made before an
 * interactive confirm does not bind what a later `gh pr merge` would pick on that head.
 */
export const fetchPRByNumber = async (number: number): Promise<PRStatus> => {
  try {
    const result = await $`gh pr view ${number} --json number,state,title,baseRefName,headRefName`

    return JSON.parse(result.stdout) as PRStatus
  } catch (error: unknown) {
    throw new OperationError(error, {
      operation: `fetch PR #${number}`,
      remediation: `check it exists with \`gh pr view ${number}\``,
    })
  }
}

export interface PRWithBody extends PRStatus {
  body: string
  createdAt: string
}

/**
 * Every PR a head ever had, newest first. Sorted here because gh's list order is not a contract,
 * and a rename resume must tell the latest PR from a superseded one.
 */
export const fetchPRsByHeadAllStates = async (head: string): Promise<PRWithBody[]> => {
  const result =
    await $`gh pr list --head ${head} --state all --limit 20 --json number,state,title,body,baseRefName,headRefName,createdAt`

  const prs = JSON.parse(result.stdout) as PRWithBody[]

  return prs.toSorted((a, b) => {
    return Date.parse(b.createdAt) - Date.parse(a.createdAt)
  })
}

export const fetchPRComments = async (number: number): Promise<string[]> => {
  const result = await $`gh pr view ${String(number)} --json comments`

  const parsed = JSON.parse(result.stdout) as { comments: { body: string }[] }

  return parsed.comments.map((comment) => {
    return comment.body
  })
}

export interface PRReviewState {
  requestedReviewers: string[]
  latestReviews: { login: string; state: string }[]
}

export const fetchPRReviewState = async (number: number): Promise<PRReviewState> => {
  const result = await $`gh pr view ${String(number)} --json reviewRequests,latestReviews`

  const parsed = JSON.parse(result.stdout) as {
    reviewRequests: { login?: string }[]
    latestReviews: { author: { login: string }; state: string }[]
  }

  return {
    // A team request carries a slug, not a login; only users can be re-requested by login.
    requestedReviewers: parsed.reviewRequests.flatMap((request) => {
      return request.login ? [request.login] : []
    }),
    latestReviews: parsed.latestReviews.map((review) => {
      return { login: review.author.login, state: review.state }
    }),
  }
}
