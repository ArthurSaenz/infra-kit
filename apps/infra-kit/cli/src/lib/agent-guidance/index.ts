export { findWorkspaceRoot, resetAdoptionCache, resolveAdoption } from './adoption'
export type { AdoptionState } from './adoption'
export { LEGACY_IMPORT_END, LEGACY_IMPORT_START, syncPackageGuidance, syncRootGuidance } from './agent-guidance'
export type { GuidanceWrite, SyncPackageGuidanceOptions, SyncRootGuidanceOptions } from './agent-guidance'
export { buildDesignSkeleton } from './bodies/design-skeleton'
export { buildPackageBody } from './bodies/package-body'
export type { BuildPackageBodyArgs } from './bodies/package-body'
export { buildRootBody } from './bodies/root-body'
export { TYPE_RULES } from './bodies/type-rules'
export type { TypeRules } from './bodies/type-rules'
export { inspectPackageGuidance } from './inspect'
export type { GuidanceState, PackageGuidanceInspection } from './inspect'
export {
  PACKAGE_MARKER_END,
  PACKAGE_MARKER_START,
  PACKAGE_VERSION_PREFIX,
  ROOT_MARKER_END,
  ROOT_MARKER_START,
  ROOT_VERSION_PREFIX,
} from './markers'
export { detectPackageType, PACKAGE_TYPES } from './package-type'
export type { DetectPackageTypeArgs, PackageType, PackageTypeManifest } from './package-type'
export { readGuidanceFile } from './read-guidance-file'
export {
  assertBlockPresent,
  assertNotSymlink,
  assertOutsideMarkersUnchanged,
  backupFile,
  classifyGitState,
  resetGitStateCache,
  writeManaged,
} from './write-managed-file'
export type { BackupPolicy, GitState, WriteAction, WriteManagedOptions } from './write-managed-file'
