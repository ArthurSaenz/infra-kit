/**
 * Validation rules for a single workspace package, declared in its
 * `infra-kit.config.js`. Every field is optional: a key left unset falls back to
 * the active baseline ({@link DEFAULT_RULES} for packages, {@link ROOT_DEFAULT_RULES}
 * for the monorepo root), and a key set replaces that default wholesale (per-key,
 * no array concatenation) so a package can opt out with an explicit empty array.
 *
 * Most packages need none of these — the standard rules live in the baseline, so
 * a typical config is just `defineConfig(() => ({}))`.
 *
 * @example
 * // infra-kit.config.js
 * import { defineConfig } from 'infra-kit'
 *
 * export default defineConfig(() => ({}))
 */
export interface InfraKitPackageConfig {
  /** Scripts that must be present in the package's package.json `scripts` map. */
  requiredScripts?: string[]
  /** Files (relative to the package root) that must exist on disk. */
  requiredFiles?: string[]
  /** Turborepo expectations — only meaningful where a turbo.json lives (the root). */
  turbo?: {
    /** Tasks that must be defined in turbo.json `tasks`. */
    requiredTasks?: string[]
  }
  /** Local-dev configuration. Accepted-and-inert to the audit; consumed by the dev server. */
  dev?: InfraKitDev
}

/** A proxy route's allowed backend source. */
export type InfraKitDevProxySource = 'local' | 'cloud'

export interface InfraKitDevProxyRoute {
  /** Backend package this route targets when resolved locally. */
  packageName: string
  /** Capabilities this route can resolve to. Must be non-empty. */
  from: InfraKitDevProxySource[]
  /**
   * Source used when a local backend for this package isn't active. Required when
   * `from` lists more than one source; redundant (and omitted) for a single-source
   * route. When set, must be one of `from`.
   */
  default?: InfraKitDevProxySource
}

export interface InfraKitDevProxy {
  /** URL templates. Placeholders like `<release>`/`<packageName>`/`<env>` are substituted at dev time. */
  templates: {
    local: string
    cloud: string
  }
  /** Path-prefix (e.g. `/api`, `/api/v1`, `/media`) → route definition. */
  routes: Record<string, InfraKitDevProxyRoute>
}

export interface InfraKitDev {
  proxy?: InfraKitDevProxy
}

/**
 * Accepted shapes for a package config's default export — mirrors Vite's
 * `defineConfig` input: a plain object, a sync factory, or an async factory.
 */
export type InfraKitPackageConfigInput =
  InfraKitPackageConfig | (() => InfraKitPackageConfig) | (() => Promise<InfraKitPackageConfig>)

/**
 * Identity helper that gives `infra-kit.config.js` authors full type inference
 * and editor autocomplete without changing the value — exactly like Vite's
 * `defineConfig`. Resolution of the factory form happens in the loader, not here.
 *
 * @example
 * export default defineConfig(() => ({}))
 *
 * @example
 * export default defineConfig(() => ({ requiredScripts: [] }))
 */
export const defineConfig = (config: InfraKitPackageConfigInput): InfraKitPackageConfigInput => {
  return config
}

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
