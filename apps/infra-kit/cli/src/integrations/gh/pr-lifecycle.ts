import { $ } from 'zx'

const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting'])

export interface OpenReleasePrParams {
  head: string
  base: string
  title: string
  body: string
  labels: string[]
  assignees: string[]
  milestone: string | null
  draft: boolean
}

/** Returns the new PR number, parsed from the URL `gh pr create` prints. */
export const openReleasePr = async (params: OpenReleasePrParams): Promise<number> => {
  const args = ['--title', params.title, '--body', params.body, '--base', params.base, '--head', params.head]

  // One flag per value: gh splits a comma inside a single `--label` value, and label names may hold commas.
  for (const label of params.labels) args.push('--label', label)
  for (const assignee of params.assignees) args.push('--assignee', assignee)

  if (params.milestone) args.push('--milestone', params.milestone)
  if (params.draft) args.push('--draft')

  const result = await $`gh pr create ${args}`

  const match = /\/pull\/(\d+)\s*$/.exec(result.stdout.trim())

  if (!match) throw new Error(`could not read the new PR number from gh output: ${result.stdout.trim()}`)

  return Number(match[1])
}

export const retargetPrBase = async (number: number, base: string): Promise<void> => {
  await $`gh pr edit ${String(number)} --base ${base}`
}

export const closePrWithComment = async (number: number, comment: string): Promise<void> => {
  await $`gh pr close ${String(number)} --comment ${comment}`
}

export interface PRMetadata {
  title: string
  body: string
  baseRefName: string
  isDraft: boolean
  labels: string[]
  assignees: string[]
  milestone: string | null
}

export const fetchPRMetadata = async (number: number): Promise<PRMetadata> => {
  const result = await $`gh pr view ${String(number)} --json title,body,baseRefName,isDraft,labels,assignees,milestone`

  const parsed = JSON.parse(result.stdout) as {
    title: string
    body: string
    baseRefName: string
    isDraft: boolean
    labels: { name: string }[]
    assignees: { login: string }[]
    milestone: { title: string } | null
  }

  return {
    title: parsed.title,
    body: parsed.body,
    baseRefName: parsed.baseRefName,
    isDraft: parsed.isDraft,
    labels: parsed.labels.map((label) => {
      return label.name
    }),
    assignees: parsed.assignees.map((assignee) => {
      return assignee.login
    }),
    milestone: parsed.milestone?.title ?? null,
  }
}

export interface RenamePermissions {
  canPush: boolean
  oldProtected: boolean
  oldRules: string[]
  newRules: string[]
}

// gh reports a missing branch as an HTTP 404 on stderr; for these probes that means "no protection".
const isNotFound = (error: unknown): boolean => {
  const text = [(error as { stderr?: unknown }).stderr, (error as { message?: unknown }).message].join(' ')

  return /HTTP 404|Not Found/i.test(text)
}

const apiOrNull = async (path: string, jq?: string): Promise<string | null> => {
  try {
    const result = jq ? await $`gh api ${path} --jq ${jq}` : await $`gh api ${path}`

    return result.stdout.trim()
  } catch (error: unknown) {
    if (isNotFound(error)) return null

    throw error
  }
}

const fetchBranchRules = async (branch: string): Promise<string[]> => {
  const raw = await apiOrNull(`repos/{owner}/{repo}/rules/branches/${encodeURIComponent(branch)}`)

  if (!raw) return []

  return (JSON.parse(raw) as { type: string }[]).map((rule) => {
    return rule.type
  })
}

export const fetchRenamePermissions = async (oldBranch: string, newBranch: string): Promise<RenamePermissions> => {
  const permissions = JSON.parse((await apiOrNull('repos/{owner}/{repo}', '.permissions')) ?? '{}') as {
    push?: boolean
  }

  const oldProtected = await apiOrNull(`repos/{owner}/{repo}/branches/${encodeURIComponent(oldBranch)}`, '.protected')

  return {
    canPush: permissions.push === true,
    oldProtected: oldProtected === 'true',
    oldRules: await fetchBranchRules(oldBranch),
    newRules: await fetchBranchRules(newBranch),
  }
}

export interface ActiveRun {
  status: string
  workflowName: string
  databaseId: number
}

export const fetchActiveRuns = async (branch: string): Promise<ActiveRun[]> => {
  const result = await $`gh run list --branch ${branch} --json status,workflowName,databaseId --limit 50`

  return (JSON.parse(result.stdout) as ActiveRun[]).filter((run) => {
    return ACTIVE_RUN_STATUSES.has(run.status)
  })
}

export type CompareStatus = 'identical' | 'ahead' | 'behind' | 'diverged'

export const fetchCompareStatus = async (baseSha: string, headSha: string): Promise<CompareStatus> => {
  const path = `repos/{owner}/{repo}/compare/${baseSha}...${headSha}`
  const result = await $`gh api ${path} --jq .status`

  return result.stdout.trim() as CompareStatus
}

/** True when head contains every commit of base. */
export const compareContains = async (baseSha: string, headSha: string): Promise<boolean> => {
  const status = await fetchCompareStatus(baseSha, headSha)

  return status === 'identical' || status === 'ahead'
}

export interface OpenPRBody {
  number: number
  headRefName: string
  body: string
}

export const listOpenPRBodies = async (): Promise<OpenPRBody[]> => {
  const result = await $`gh pr list --state open --limit 200 --json number,headRefName,body`

  return JSON.parse(result.stdout) as OpenPRBody[]
}

export const listOpenPRsByBase = async (base: string): Promise<{ number: number; headRefName: string }[]> => {
  const result = await $`gh pr list --base ${base} --state open --json number,headRefName`

  return JSON.parse(result.stdout) as { number: number; headRefName: string }[]
}
