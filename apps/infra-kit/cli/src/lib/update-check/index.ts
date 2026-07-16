export { maybeAutoUpdate } from './auto-update'
export type { AutoUpdateDeps } from './auto-update'
export { autoUpdateSkipReason, OPT_OUT_ENV_VARS } from './guards'
export type { AutoUpdateGuardInput, SkipReason } from './guards'
export { acquireUpdateLock, LOCK_FILE_NAME, LOCK_STALE_MS, lockFilePath } from './lock'
export { DEFAULT_REGISTRY, FETCH_TIMEOUT_MS, fetchLatestVersion, registryUrl } from './registry'
export { PARENT_POLL_INTERVAL_MS, PARENT_WAIT_TIMEOUT_MS, runUpdateCheck } from './run-update-check'
export type { RunUpdateCheckDeps, UpdateCheckOutcome } from './run-update-check'
export { isNewerVersion, parseSemver } from './semver'
export {
  CACHE_FILE_NAME,
  cacheFilePath,
  CHECK_INTERVAL_MS,
  isStale,
  readUpdateCache,
  RETRY_INTERVAL_MS,
  writeUpdateCache,
} from './update-cache'
export type { UpdateCache } from './update-cache'
