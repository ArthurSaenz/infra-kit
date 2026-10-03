import input from '@inquirer/input'
import select from '@inquirer/select'
import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { formatBranchName, parseReleaseRef } from 'src/lib/release-id'

export const DEFAULT_FEATURE_BASE = 'dev'

/** Accepted as a base even when `origin/HEAD` records no default branch. */
const MAIN_BRANCH = 'main'

const FEATURE_PREFIX = 'feature/'

export type WorktreeKind = 'release' | 'feature'

/**
 * Where the branch comes from: `new` is cut from `origin/<base>`; `local` / `remote` reuse a branch
 * that already exists (resuming someone's PR), so `base` is not applied to them.
 */
export type FeatureBranchSource = 'new' | 'local' | 'remote'

export const FEATURE_BRANCH_SOURCES = ['new', 'local', 'remote'] as const

export interface FeatureWorktreePlan {
  branch: string
  base: string
  source: FeatureBranchSource
}

/**
 * Normalize a feature name to its branch, accepting it with or without the prefix.
 *
 * @example
 * toFeatureBranch(' Checkout V2 ') // => 'feature/checkout-v2'
 * toFeatureBranch('feature/checkout-v2') // => 'feature/checkout-v2'
 */
export const toFeatureBranch = (name: string): string => {
  const slug = name
    .trim()
    .replace(/^feature\//, '')
    .toLowerCase()
    .replaceAll(/\s+/g, '-')

  return `${FEATURE_PREFIX}${slug}`
}

/** The branch `origin/HEAD` points at, or null when the clone records none. */
const readDefaultBranch = async (): Promise<string | null> => {
  const head = await $({ nothrow: true, quiet: true })`git symbolic-ref --quiet --short refs/remotes/origin/HEAD`
  const branch = head.exitCode === 0 ? head.stdout.trim().replace(/^origin\//, '') : ''

  return branch === '' ? null : branch
}

/** `git ls-remote --exit-code` exits 2 when the ref is missing; anything else non-zero is a failed probe. */
const LS_REMOTE_NO_MATCH = 2

/**
 * The base when none is passed: `dev`, or the repo's default branch in a repo without one (infra-kit
 * itself has only `main`). Falls back to `dev` when neither resolves, so the base check names it.
 *
 * @throws When origin cannot be asked (network, auth): cutting from the default branch then would be a
 *   silent guess in a repo that may well have `dev`.
 */
export const defaultFeatureBase = async (): Promise<string> => {
  // A full ref: a bare `dev` pattern also matches any `*/dev` branch. ls-remote, not fetch, because
  // planFeatureWorktrees fetches whichever base this picks.
  const probe = await $({
    nothrow: true,
    quiet: true,
  })`git ls-remote --exit-code origin refs/heads/${DEFAULT_FEATURE_BASE}`

  if (probe.exitCode === 0) return DEFAULT_FEATURE_BASE

  if (probe.exitCode !== LS_REMOTE_NO_MATCH) {
    throw new OperationError(undefined, {
      operation: 'create feature worktree',
      remediation: 'check the network and your access to origin, or pass --base explicitly',
      stderrExcerpt: probe.stderr.trim() || `could not ask origin whether ${DEFAULT_FEATURE_BASE} exists`,
    })
  }

  return (await readDefaultBranch()) ?? DEFAULT_FEATURE_BASE
}

/**
 * `dev`, `main` / the repo's default branch, or a release ref (`1.4.0`, `v1.4.0`, `release/v1.4.0`,
 * `release/<name>`), as a branch name. No base: {@link defaultFeatureBase}.
 *
 * @example
 * await resolveFeatureBase('1.4.0') // => 'release/v1.4.0'
 * await resolveFeatureBase('main') // => 'main'
 */
export const resolveFeatureBase = async (base: string | undefined): Promise<string> => {
  const trimmed = base?.trim()

  if (!trimmed) return defaultFeatureBase()

  if (trimmed === DEFAULT_FEATURE_BASE || trimmed === MAIN_BRANCH || trimmed === (await readDefaultBranch())) {
    return trimmed
  }

  return formatBranchName(parseReleaseRef(trimmed))
}

/** The interactive "which kind" question; only asked when no flag chose already. */
export const promptWorktreeKind = async (): Promise<WorktreeKind> => {
  return withEscape(
    (context) => {
      return select<WorktreeKind>(
        {
          message: 'What kind of worktree?',
          choices: [
            { name: 'Release — worktrees for open release branches', value: 'release' },
            { name: 'Feature — a new or existing feature/* branch', value: 'feature' },
          ],
        },
        context,
      )
    },
    { whenHeadless: { value: 'release' } },
  )
}

export const promptFeatureName = async (): Promise<string> => {
  return withEscape(
    (context) => {
      return input(
        {
          message: 'Feature name (becomes feature/<name>):',
          required: true,
          validate: (value) => {
            return toFeatureBranch(value) === FEATURE_PREFIX ? 'Enter a name' : true
          },
        },
        context,
      )
    },
    { whenHeadless: { refuse: 'feature' } },
  )
}

export const promptFeatureBase = async (releaseBranches: string[], defaultBase: string): Promise<string> => {
  if (releaseBranches.length === 0) return defaultBase

  return withEscape(
    (context) => {
      return select<string>(
        {
          message: 'Base branch:',
          default: defaultBase,
          choices: [defaultBase, ...releaseBranches].map((branch) => {
            return { name: branch, value: branch }
          }),
        },
        context,
      )
    },
    { whenHeadless: { value: defaultBase } },
  )
}

const assertValidBranchName = async (branch: string): Promise<void> => {
  const check = await $({ nothrow: true, quiet: true })`git check-ref-format --branch ${branch}`

  if (branch === FEATURE_PREFIX || check.exitCode !== 0) {
    throw new OperationError(undefined, {
      operation: 'create feature worktree',
      remediation: 'pass a feature name made of letters, digits, `-`, `_`, `.` or `/`, e.g. --feature checkout-v2',
      stderrExcerpt: `"${branch}" is not a valid branch name`,
    })
  }
}

/** `git fetch origin <branch>` exits non-zero when the remote has no such branch — the existence probe. */
const fetchRemoteBranch = async (branch: string): Promise<boolean> => {
  const fetched = await $({ nothrow: true, quiet: true })`git fetch origin ${branch}`

  return fetched.exitCode === 0
}

const hasLocalBranch = async (branch: string): Promise<boolean> => {
  const ref = await $({ nothrow: true, quiet: true })`git show-ref --verify --quiet refs/heads/${branch}`

  return ref.exitCode === 0
}

interface PlanFeatureWorktreesArgs {
  names: string[]
  base: string
}

/**
 * Validate the names, fetch the base, and decide per branch whether it is cut fresh or reused.
 * Runs BEFORE the confirm so the preview can say which branches are new and what they start from.
 */
export const planFeatureWorktrees = async (args: PlanFeatureWorktreesArgs): Promise<FeatureWorktreePlan[]> => {
  const { names, base } = args
  const branches = [...new Set(names.map(toFeatureBranch))]

  for (const branch of branches) {
    await assertValidBranchName(branch)
  }

  if (!(await fetchRemoteBranch(base))) {
    throw new OperationError(undefined, {
      operation: 'create feature worktree',
      remediation: `pass --base dev, --base main or an existing release branch (\`infra-kit release list\` lists them); a repo with neither dev nor a recorded default branch needs \`git remote set-head origin --auto\``,
      stderrExcerpt: `base branch origin/${base} not found`,
    })
  }

  const plans: FeatureWorktreePlan[] = []

  for (const branch of branches) {
    if (await hasLocalBranch(branch)) {
      plans.push({ branch, base, source: 'local' })
    } else if (await fetchRemoteBranch(branch)) {
      plans.push({ branch, base, source: 'remote' })
    } else {
      plans.push({ branch, base, source: 'new' })
    }
  }

  return plans
}

/**
 * A new branch is `--no-track`: tracking `origin/<base>` would make a bare `git push` target the base.
 * The first `git push -u origin <branch>` sets the real upstream.
 */
export const addFeatureWorktree = async (plan: FeatureWorktreePlan, worktreePath: string): Promise<void> => {
  const { branch, base, source } = plan

  if (source === 'local') {
    await $`git worktree add ${worktreePath} ${branch}`
  } else if (source === 'remote') {
    await $`git worktree add --track -b ${branch} ${worktreePath} origin/${branch}`
  } else {
    await $`git worktree add --no-track -b ${branch} ${worktreePath} origin/${base}`
  }
}

export const describeFeaturePlan = (plan: FeatureWorktreePlan): string => {
  if (plan.source === 'new') return `  • ${plan.branch}: new branch from origin/${plan.base}`

  return `  • ${plan.branch}: existing ${plan.source === 'local' ? 'local' : 'remote'} branch (base not applied)`
}
