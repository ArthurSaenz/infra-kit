import type { InfraKitPackageConfig } from '@slip-stream-kit/config'

/**
 * Audit POLICY: the baselines a package's `infra-kit.config.ts` is resolved against, and the merge
 * that resolves it.
 *
 * The config-authoring surface (`defineConfig`, the `InfraKit*` types, `packageConfigSchema`) lives in
 * `@slip-stream-kit/config` — a separate npm package a consumer installs locally. The baselines
 * deliberately did NOT move with it: they are decisions this CLI enforces, not a contract a consumer
 * authors against. Shipping them to consumers would freeze audit policy into their lockfiles and make
 * every rule change a coordinated release.
 */

/** Fully-resolved rules with every defaultable field present. */
export interface ResolvedPackageRules {
  requiredScripts: string[]
  requiredFiles: string[]
  turboTasks: string[]
}

/**
 * Baseline rules for a standard TypeScript workspace package, applied to any key
 * a package leaves unset. These are the "under the hood" defaults so a conforming
 * package's config can stay empty; non-standard packages override the relevant key.
 */
export const DEFAULT_RULES: Readonly<ResolvedPackageRules> = {
  requiredScripts: ['build', 'ts-check', 'eslint-check', 'prettier-check', 'test'],
  requiredFiles: ['tsconfig.json', 'eslint.config.js', 'readme.md'],
  turboTasks: [],
}

/**
 * Baseline rules for the monorepo root (`infra-kit audit --root`). Checks the
 * root commands, the workspace/turbo files, and that the turbo pipeline defines
 * the expected tasks — so the root's own config can also stay empty.
 */
export const ROOT_DEFAULT_RULES: Readonly<ResolvedPackageRules> = {
  requiredScripts: ['build', 'dev', 'test', 'qa', 'infra-kit-check', 'fix'],
  requiredFiles: ['turbo.json', 'pnpm-workspace.yaml'],
  turboTasks: ['build', 'test', 'ts-check', 'eslint-check', 'prettier-check', 'infra-kit-check'],
}

/**
 * Merge a parsed package config over a baseline. Each key is replaced wholesale
 * when the package provides it, otherwise the baseline value is used.
 *
 * @example
 * resolvePackageConfig({ requiredScripts: [] })
 * // => { requiredScripts: [], requiredFiles: [...DEFAULT_RULES.requiredFiles], turboTasks: [] }
 */
export const resolvePackageConfig = (
  config: InfraKitPackageConfig,
  baseline: Readonly<ResolvedPackageRules> = DEFAULT_RULES,
): ResolvedPackageRules => {
  return {
    requiredScripts: config.requiredScripts ?? [...baseline.requiredScripts],
    requiredFiles: config.requiredFiles ?? [...baseline.requiredFiles],
    turboTasks: config.turbo?.requiredTasks ?? [...baseline.turboTasks],
  }
}
