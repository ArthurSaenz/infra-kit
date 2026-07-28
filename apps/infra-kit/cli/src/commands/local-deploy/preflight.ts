import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'
import { assertDeployable } from 'src/lib/workflow-envs/protected-envs'

/** Checks a caller may waive by name. `env-account` and `protected-env` are deliberately absent. */
export const SKIPPABLE_CHECKS = ['clean-tree', 'toolchain'] as const

export type SkippableCheck = (typeof SKIPPABLE_CHECKS)[number]

export interface AccountIdentity {
  accountId: string
  /** Value of `/{project}/environment` in the authenticated account. */
  stage: string
}

/**
 * Resolve who we are and which environment this account IS.
 *
 * Every deploy script already reads `/{project}/environment` and trusts it — `DEPLOY_STAGE` is
 * derived from the account, never passed in. So the account decides the environment, and nothing in
 * the pipeline has ever checked that it matches what the human meant.
 *
 * Throws on an unreadable parameter rather than returning a blank. An account with no such parameter
 * is precisely the "you are pointed somewhere unexpected" case this exists to catch, so treating it
 * as "probably fine" would inverts the check's purpose.
 */
export const resolveAccountIdentity = async (project: string): Promise<AccountIdentity> => {
  const previousQuiet = $.quiet

  $.quiet = true

  try {
    const parameterName = `/${project}/environment`

    const identity = await $`aws sts get-caller-identity --query Account --output text`
    const stage = await $`aws ssm get-parameter --name ${parameterName} --query Parameter.Value --output text`

    return { accountId: identity.stdout.trim(), stage: stage.stdout.trim() }
  } catch (error: unknown) {
    throw new OperationError(error, {
      operation: 'resolve the AWS account for this deploy',
      remediation:
        `check that credentials are loaded and that \`/${project}/environment\` exists in the ` +
        `account they point at — run \`aws sts get-caller-identity\` to see which account that is`,
    })
  } finally {
    $.quiet = previousQuiet
  }
}

/**
 * Refuse unless the environment the caller asked for is the one the account actually is.
 *
 * The single check that makes a laptop deploy safe. Credentials live in the shell, so the target is
 * whatever profile happens to be exported — a stale `AWS_PROFILE` is the ordinary way to deploy to the
 * wrong place, and every script downstream would read the account's own answer and proceed happily.
 *
 * Names both values, because "wrong environment" is not actionable and
 * "you asked for arthur, account 1234 says prod" is.
 */
export const assertEnvMatchesAccount = (intended: string, identity: AccountIdentity): void => {
  if (identity.stage === intended) return

  throw new OperationError(undefined, {
    operation: 'verify the target environment',
    remediation: 'switch AWS_PROFILE to the account for this environment, or pass the env this account is',
    stderrExcerpt:
      `you asked for "${intended}", but AWS account ${identity.accountId} reports "${identity.stage}" ` +
      `— refusing to deploy to an environment you did not name`,
  })
}

/**
 * Refuse to deploy a dirty tree to an environment other people use.
 *
 * Shared environments only. A personal env is a scratch target where deploying uncommitted work is
 * the entire point; `dev` is not, and there the cost of being wrong is everyone else's afternoon.
 */
export const assertCleanTreeForSharedEnv = (args: { env: string; isShared: boolean; isClean: boolean }): void => {
  const { env, isShared, isClean } = args

  if (!isShared || isClean) return

  throw new OperationError(undefined, {
    operation: `deploy to shared environment "${env}"`,
    remediation: 'commit or stash first, or deploy to a personal environment instead',
    stderrExcerpt: 'the working tree has uncommitted changes and this environment is shared',
  })
}

/**
 * Refuse while CI is already deploying to the same environment.
 *
 * `deploy-all.yml` sets `concurrency: group: deploy-all-<env>, cancel-in-progress: true`, which makes
 * CI runs mutually exclusive — but a local deploy is invisible to that group, so nothing stops the two
 * from interleaving. Serverless would fail loudly on a CloudFormation conflict; an S3 sync racing a
 * CloudFront invalidation would not, and would leave a half-updated bundle.
 *
 * Advisory input: pass `runningEnvs` from `gh run list`. An empty list when `gh` is unavailable means
 * this check passes — it is a race guard, not a security control, and failing closed on a missing
 * optional tool would make the command unusable offline.
 */
export const assertNoCiDeployInFlight = (env: string, runningEnvs: string[]): void => {
  if (!runningEnvs.includes(env)) return

  throw new OperationError(undefined, {
    operation: `deploy to "${env}"`,
    remediation: 'wait for the CI run to finish, or watch it with `gh run watch`',
    stderrExcerpt: `a CI deploy to "${env}" is already in flight — running both would interleave`,
  })
}

export interface PreflightArgs {
  env: string
  project: string
  isShared: boolean
  isClean: boolean
  runningEnvs: string[]
  skip: SkippableCheck[]
}

export interface PreflightResult {
  identity: AccountIdentity
  skipped: SkippableCheck[]
}

/**
 * Run every gate, in order, before anything is spawned.
 *
 * Ordered cheapest-and-most-absolute first: policy needs no network, the account lookup does. A
 * failure here must leave the world untouched, which is why this runs to completion before the first
 * child process exists.
 */
export const runPreflight = async (args: PreflightArgs): Promise<PreflightResult> => {
  const { env, project, isShared, isClean, runningEnvs, skip } = args

  // `prod` is delivered, never deployed ad-hoc — the one client-side veto, shared with the
  // workflow-dispatch commands so both paths refuse it identically.
  assertDeployable(env, `deploy to "${env}"`)

  assertNoCiDeployInFlight(env, runningEnvs)

  if (!skip.includes('clean-tree')) {
    assertCleanTreeForSharedEnv({ env, isShared, isClean })
  }

  const identity = await resolveAccountIdentity(project)

  assertEnvMatchesAccount(env, identity)

  return { identity, skipped: skip }
}
