import { $ } from 'zx'

type PRState = 'OPEN' | 'MERGED' | 'CLOSED'

export interface PRStatus {
  number: number
  state: PRState
  title: string
}

/**
 * Fetch the (most-recent) PR for the given head branch, across all states, so
 * we can resume a partially-completed delivery: a PR merged on a prior attempt
 * still appears here as `state: 'MERGED'`, letting the caller skip the merge.
 */
export const fetchPRByHead = async (head: string): Promise<PRStatus | null> => {
  const result = await $`gh pr list --head ${head} --state all --json number,state,title --limit 1`
  const prs = JSON.parse(result.stdout) as PRStatus[]

  return prs[0] ?? null
}
