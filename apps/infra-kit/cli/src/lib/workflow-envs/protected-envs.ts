import { OperationError } from 'src/lib/errors/operation-error'

/**
 * Environments that must NOT be reachable from the ad-hoc deploy commands.
 *
 * `prod` is not a deploy target — it is a DELIVERY target. `gh-release-deliver` is the only sanctioned
 * path to it, and it is a whole flow, not a dispatch: squash-merge the release branch to `main`, open
 * and merge the RC PR, dispatch `deploy-all.yml --ref main -f environment=prod` (see
 * `gh-release-deliver.ts`), then release the matching Jira fix version. Letting
 * `gh-release-deploy-all --env prod` dispatch straight from a release branch would skip every one of
 * those steps and ship production from an unmerged ref.
 *
 * `stage` is deliberately NOT here. The old per-repo allowlists excluded it, but nothing delivers to it
 * either — so it was simply unreachable, which was an oversight rather than a policy. It is an ad-hoc
 * deploy target like any other.
 *
 * This is a POLICY, which is why it lives in code rather than in each repo's config. The workflows
 * themselves legitimately declare `prod` in their `environment` options (the delivery flow needs it);
 * what is forbidden is the CLI's ad-hoc path reaching it. That rule used to be encoded as a
 * hand-maintained `environments` array in five `infra-kit.json` files — five copies of one rule, which
 * drifted (travelist's listed `roman` and `eliran`, whom its own `deploy-all.yml` does not accept).
 */
export const PROTECTED_ENVS = ['prod']

/** Whether an environment is reserved for the delivery flow rather than ad-hoc deploys. */
export const isProtectedEnv = (env: string): boolean => {
  return PROTECTED_ENVS.includes(env)
}

/** Drop the delivery-only environments from a workflow's declared options — the ad-hoc deploy picker. */
export const deployableEnvs = (options: string[]): string[] => {
  return options.filter((env) => {
    return !isProtectedEnv(env)
  })
}

/**
 * Refuse a delivery-only environment, naming the flow that DOES own it.
 *
 * The one client-side veto worth keeping. Everything else about the old `environments` check was a
 * stale local copy of a list GitHub already enforces — but GitHub cannot enforce this, because from its
 * side `-f environment=prod` is a perfectly valid choice. The rule being protected is ours.
 *
 * @example
 * assertDeployable('dev', 'launch deploy-all workflow')  // ok
 * assertDeployable('prod', 'launch deploy-all workflow') // throws — use `infra-kit release deliver`
 */
export const assertDeployable = (env: string, operation: string): void => {
  if (!isProtectedEnv(env)) return

  throw new OperationError(undefined, {
    operation,
    remediation:
      `use \`infra-kit release deliver\` — it merges the release to main, opens the RC PR, ` +
      `deploys from main, and releases the Jira version`,
    stderrExcerpt: `"${env}" is delivered, not deployed ad-hoc`,
  })
}
