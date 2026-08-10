import { logger } from 'src/lib/logger'

import { isProtectedEnv } from './protected-envs'

/**
 * Warn, at selection time, about what an ad-hoc dispatch to a delivery-shaped environment SKIPS.
 *
 * This is the knowledge the refusal in `assertDeployable` used to carry. A project that sets
 * `protectedEnvs` to `"allow"` removes the block, and the block was the only place in the codebase
 * recording WHY `prod` was special — so the sentence has to outlive it, or the next person learns the
 * hard way that `release deploy-all --env prod` is `release deliver` minus its bookkeeping.
 *
 * Deliberately a warning and not a second confirmation: the project already decided, and a prompt the
 * user cannot act on differently is just friction. The dispatch commands run their own `confirmDeploy`
 * immediately after this.
 *
 * Shared by both dispatch commands rather than copied: `gh-release-deploy-selected` already carries a
 * cognitive-complexity suppression, and this must not add to it.
 *
 * @example
 * warnProtectedEnvDispatch({ env: 'prod', branch: 'release/1.9.0' }) // logs the skipped steps
 * warnProtectedEnvDispatch({ env: 'dev', branch: 'release/1.9.0' })  // no-op
 */
export const warnProtectedEnvDispatch = (args: { env: string; branch: string }): void => {
  const { env, branch } = args

  if (!isProtectedEnv(env)) return

  logger.warn(
    [
      `⚠️ "${env}" is a delivery target — this project allows dispatching to it directly, but this is NOT the delivery flow.`,
      `Dispatching from "${branch}" ships ${env} from a ref that is not merged to main, and skips:`,
      '  • the squash-merge of the release branch into main',
      '  • the RC pull request',
      '  • the Jira fix-version release',
      'Run `infra-kit release deliver` instead if you want those.',
    ].join('\n'),
  )
}
