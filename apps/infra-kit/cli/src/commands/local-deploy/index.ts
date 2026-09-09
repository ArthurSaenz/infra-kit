export { buildDeployEnv, contractRecord, formatContract } from './deploy-env'
export type { BuildEnvResult, DeployContract } from './deploy-env'
export { localDeployAll, localDeployAllMcpTool, localDeploySelected, localDeploySelectedMcpTool } from './local-deploy'
export {
  assertCleanTreeForSharedEnv,
  assertEnvMatchesAccount,
  assertNoCiDeployInFlight,
  runPreflight,
} from './preflight'
export type { AccountIdentity } from './preflight'
export { discoverServices, eligibleServices, isEligible } from './service-discovery'
export type { DeployService } from './service-discovery'
// `workflow-gates` no longer lives here: it moved to `src/lib/workflow-gates` when the CI path grew a
// second, workflow-scoped read. Re-exporting it from this barrel too would leave two importable paths
// for one module and no way to tell which is canonical, so this barrel simply drops it.
