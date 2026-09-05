import { OperationError } from 'src/lib/errors/operation-error'

/**
 * Environments that are NOT ordinary ad-hoc deploy targets by default.
 *
 * This is the DEFAULT, not an immovable policy: a project opts out with `protectedEnvs` in its
 * `infra-kit.json` (`'disallow' | 'allow' | 'cli-only'`, absent meaning `'disallow'`), resolved by
 * `protected-env-access.ts`. The LIST stays in code because it answers "what is delivery-shaped in
 * this org", which no single repo owns; the config answers "may this repo reach it", which each
 * repo does.
 */
// `prod` is not a deploy target — it is a DELIVERY target. `gh-release-deliver` is the sanctioned
// path to it, and it is a whole flow, not a dispatch: squash-merge the release branch to `main`,
// open and merge the RC PR, dispatch `deploy-all.yml --ref main -f environment=prod` (see
// `gh-release-deliver.ts`), then release the matching Jira fix version. A `gh-release-deploy-all
// --env prod` straight from a release branch skips every one of those steps and ships production
// from an unmerged ref.
//
// `stage` is deliberately NOT here. The old per-repo allowlists excluded it, but nothing delivers
// to it either — so it was simply unreachable, which was an oversight rather than a policy. It is
// an ad-hoc deploy target like any other.
//
// What is deliberately NOT rebuilt here is the deleted `environments` key — a hand-maintained
// per-repo copy of each workflow's own `environment.options` that drifted from them and turned
// that drift into a REFUSAL to deploy.
export const DEFAULT_PROTECTED_ENVS = ['prod']

/**
 * A project's resolved access to {@link DEFAULT_PROTECTED_ENVS}, and WHY.
 *
 * The reason is not decoration: a refusal because the project disallows protected envs and a refusal
 * because the caller is an agent under `'cli-only'` need opposite remediation. Collapsed to a bare
 * boolean, the second case emits "prod is delivered, not deployed" and sends an agent off to run the
 * delivery flow, or to report that prod is unconfigured for the project.
 *
 * Declared here, in the pure leaf, so `protected-env-access.ts` depends on this module and never the
 * reverse.
 */
export interface ProtectedEnvAccess {
  allowed: boolean
  reason: 'disallow' | 'mcp-blocked' | 'allowed'
}

/**
 * No access — the DEFAULT for every function below.
 *
 * That default is the safety property of this module: a call site that forgets to thread the resolved
 * access refuses rather than permits, so a seventh caller is fail-closed until someone deliberately
 * opts it in.
 */
export const PROTECTED_ENV_DENIED: ProtectedEnvAccess = { allowed: false, reason: 'disallow' }

/** Whether an environment is delivery-shaped by default, before any project opt-out. */
export const isProtectedEnv = (env: string): boolean => {
  return DEFAULT_PROTECTED_ENVS.includes(env)
}

/**
 * The ad-hoc deploy picker: a workflow's declared options, minus what this project may not reach.
 *
 * @example
 * deployableEnvs(['dev', 'prod'])                              // => ['dev']
 * deployableEnvs(['dev', 'prod'], { allowed: true, reason: 'allowed' }) // => ['dev', 'prod']
 */
export const deployableEnvs = (options: string[], access: ProtectedEnvAccess = PROTECTED_ENV_DENIED): string[] => {
  if (access.allowed) return options

  return options.filter((env) => {
    return !isProtectedEnv(env)
  })
}

/**
 * Refuse a protected environment this project may not reach, naming the fix for THIS refusal.
 *
 * GitHub cannot enforce either rule for us — from its side `-f environment=prod` is a perfectly valid
 * choice — so both are ours. Note what is NOT vetoed: an env absent from the local YAML still
 * dispatches, because that read is of the working tree while the run targets `--ref <branch>`, and
 * GitHub validates the choice itself.
 *
 * @example
 * assertDeployable('dev', 'launch deploy-all workflow')  // ok
 * assertDeployable('prod', 'launch deploy-all workflow') // throws — use `infra-kit release deliver`
 */
export const assertDeployable = (
  env: string,
  operation: string,
  access: ProtectedEnvAccess = PROTECTED_ENV_DENIED,
): void => {
  if (access.allowed) return
  if (!isProtectedEnv(env)) return

  if (access.reason === 'mcp-blocked') {
    throw new OperationError(undefined, {
      operation,
      remediation:
        `run it yourself in a terminal — this project sets \`protectedEnvs: "cli-only"\`, which ` +
        `deliberately withholds "${env}" from agents while allowing it on the CLI`,
      stderrExcerpt: `"${env}" is not reachable over MCP in this project`,
    })
  }

  throw new OperationError(undefined, {
    operation,
    remediation:
      `use \`infra-kit release deliver\` — it merges the release to main, opens the RC PR, ` +
      `deploys from main, and releases the Jira version. To allow ad-hoc deploys to "${env}" in this ` +
      `project, set \`protectedEnvs\` to "allow" or "cli-only" in infra-kit.json`,
    stderrExcerpt: `"${env}" is delivered, not deployed ad-hoc`,
  })
}
