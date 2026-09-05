import process from 'node:process'

/** Vars the deploy build reads. Everything else in `VITE_*` is ambient noise and gets stripped. */
export interface DeployContract {
  VITE_DOMAIN_ENV: string
  VITE_BRANCH_NAME: string
  VITE_COMMIT_HASH: string
}

/**
 * The contract as a plain record, for the MCP `outputSchema`.
 *
 * An `interface` has no implicit index signature, so it is not assignable to `Record<string, string>`
 * — hence the explicit widening here rather than at each call site.
 */
export const contractRecord = (contract: DeployContract): Record<string, string> => {
  return { ...contract }
}

export interface BuildEnvArgs {
  env: string
  branch: string
  sha: string
  /**
   * Whether the working tree matched HEAD when the deploy started.
   *
   * Required, not defaulted: an omitted value would silently produce the confident label, which is the
   * exact defect this argument exists to remove.
   */
  isClean: boolean
  /** Defaults to `process.env`; injectable so tests never depend on the ambient shell. */
  ambient?: NodeJS.ProcessEnv
}

export interface BuildEnvResult {
  /** The full child environment to spawn the deploy script with. */
  childEnv: NodeJS.ProcessEnv
  /** The three contract values, for `--print-env` and the run record. */
  contract: DeployContract
  /** Names of ambient `VITE_*` vars that were dropped. Names only — values may be secrets. */
  stripped: string[]
}

/**
 * Build the environment a deploy script runs under — the whole point of this command.
 *
 * The deploy scripts are NOT self-contained. `_deploy-serverless-jobs.yml` sets `VITE_DOMAIN_ENV`,
 * `VITE_BRANCH_NAME` and `VITE_COMMIT_HASH` in the workflow YAML, and no script sets them. Run a
 * script straight from a laptop and they are simply unset — at which point
 * `apps/backoffice/ui/src/lib/constants/index.ts` falls through to `https://www.hulyo.co.il`, so a
 * bundle deployed to a dev environment links to PRODUCTION. Silently, with a green deploy. This
 * function is what closes that gap, and it is why `infra-kit local deploy-all` exists rather than a README
 * telling people which vars to export.
 *
 * The strip is the other half. Builds run `turbo … --env-mode=loose`, which passes the entire ambient
 * environment through, and `turbo.json` declares `build.env: ["VITE_*"]`. After `infra-kit env-load` a
 * developer's shell carries Doppler values — so without stripping, a local deploy would bake whatever
 * `VITE_*` happens to be exported into an artifact shipped to a shared environment.
 *
 * `DEPLOY_*` are set alongside so the same invocation keeps working if the scripts later grow a
 * `deploy-env.sh` of their own; nothing reads them today.
 *
 * @example
 * buildDeployEnv({ env: 'arthur', branch: 'dev', sha: 'abc123', ambient: { VITE_LEAK: 'x' } })
 * // => stripped: ['VITE_LEAK'], contract.VITE_DOMAIN_ENV: 'arthur'
 */
export const buildDeployEnv = (args: BuildEnvArgs): BuildEnvResult => {
  const { env, branch, sha, isClean, ambient = process.env } = args

  const contract: DeployContract = {
    VITE_DOMAIN_ENV: env,
    VITE_BRANCH_NAME: branch,
    // `git describe --dirty` convention. A dirty tree ships content that is NOT in `sha` — the build
    // reads the filesystem, not git — so labelling it with the bare sha makes "what is deployed here?"
    // permanently unanswerable. That mislabelling is worst on PERSONAL environments, where a dirty
    // tree is normal and no check refuses it, so no amount of tightening the clean-tree gate reaches
    // it. Only the display/diagnostic value is suffixed; `DEPLOY_SHA` below stays the raw sha, because
    // the deploy scripts hand it to AWS.
    VITE_COMMIT_HASH: isClean ? sha : `${sha}-dirty`,
  }

  const childEnv: NodeJS.ProcessEnv = {}
  const stripped: string[] = []

  for (const [key, value] of Object.entries(ambient)) {
    if (key.startsWith('VITE_')) {
      // Recorded as stripped even when the contract re-sets it: the ambient value did not survive,
      // and saying so is what makes a wrong-looking build explainable after the fact.
      stripped.push(key)
      continue
    }

    childEnv[key] = value
  }

  stripped.sort()

  return {
    childEnv: {
      ...childEnv,
      ...contract,
      DEPLOY_ENV: env,
      DEPLOY_BRANCH: branch,
      DEPLOY_SHA: sha,
      // The dirty-aware label, carried in a NON-`VITE_` variable on purpose.
      //
      // The Phase-0 `devops/scripts/lib/deploy-env.sh` contract strips every ambient `VITE_*` and then
      // rebuilds `VITE_COMMIT_HASH` from `DEPLOY_SHA` — which is raw by design, because the scripts hand
      // it to AWS. So the moment that script lands in a consumer repo it would erase the `-dirty`
      // marker set above. This variable survives the strip, so the script's contract can prefer it and
      // the marker outlives Phase 0. See docs/local-deploy-design.md §9.1.
      DEPLOY_SHA_LABEL: contract.VITE_COMMIT_HASH,
      // Deploy builds are not interactive and telemetry noise obscures the failure line we surface.
      TURBO_TELEMETRY_DISABLED: '1',
    },
    contract,
    stripped,
  }
}

/**
 * The contract as printed by `--print-env` and `--dry-run`.
 *
 * Prints the three contract keys and nothing else. Never dump the child environment: it inherits the
 * caller's shell, which is exactly where `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` live.
 */
export const formatContract = (result: BuildEnvResult): string => {
  const lines = Object.entries(result.contract).map(([key, value]) => {
    return `  ${key.padEnd(17)}= ${value}`
  })

  if (result.stripped.length > 0) {
    lines.push(`  stripped from shell: ${result.stripped.join(', ')}`)
  }

  return lines.join('\n')
}
