import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'

type PRState = 'OPEN' | 'MERGED' | 'CLOSED'

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
export const fetchOpenPRsByHead = async (head: string): Promise<PRStatus[]> => {
  const result =
    await $`gh pr list --head ${head} --state open --limit 5 --json number,state,title,baseRefName,headRefName`

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
