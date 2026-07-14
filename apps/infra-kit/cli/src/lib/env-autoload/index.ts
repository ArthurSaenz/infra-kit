export { buildAuthFailureWarning, parseAuthFailureMarker } from './auth-failure'
export type { AuthFailureClassifier, AuthFailureMarker } from './auth-failure'
export { decideAutoLoad, resolveEnvAutoLoad, runEnvAutoLoad, surfaceStickyAuthFailure } from './env-autoload'
export type {
  AutoLoadDecision,
  AutoLoadDecisionInput,
  AutoLoadEnvSnapshot,
  AutoLoadTrigger,
  ResolvedEnvAutoLoad,
  RunEnvAutoLoadArgs,
} from './env-autoload'
