export {
  detectInstallManager,
  formatUpdateCommand,
  isGlobalInstall,
  isLocalNodeModulesInstall,
  PACKAGE_NAME,
  shouldWarnLocalInstall,
} from './install-manager'
// The four path predicates, exported for `lib/dependency-registry` to classify OTHER tools' binaries.
// Additive only: `detectInstallManager` still answers for THIS CLI and is untouched, because the five
// identifiers diverge per tool (aws's binary is `aws`, its formula `awscli`) and a single package name
// threaded through it would synthesise `brew upgrade aws` — a formula that does not exist.
export { hasSegment, isBrewKegOf, isWithin, npmPrefixOfPackage } from './install-manager'
export type {
  DetectInstallManagerInput,
  InstallManager,
  InstallManagerInfo,
  IsGlobalInstallInput,
  RealpathFn,
} from './install-manager'
export { defaultLazyNpmRoot } from './npm-root'
export { safeRealpath } from './safe-realpath'
