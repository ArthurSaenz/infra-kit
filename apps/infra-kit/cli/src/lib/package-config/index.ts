// Audit policy only. The config-authoring surface a consumer imports (`defineConfig`, the `InfraKit*`
// types, `packageConfigSchema`) now lives in `@slip-stream-kit/config`; import it from there.
export {
  DEFAULT_RULES,
  E2E_SCRIPTS,
  E2E_SLOW_MO_DEMO_MS,
  resolvePackageConfig,
  ROOT_DEFAULT_RULES,
} from './package-config'
export type { ResolvedPackageRules } from './package-config'
