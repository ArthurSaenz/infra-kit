/**
 * Validation rules for a single workspace package, declared in its
 * `infra-kit.config.ts`. Every field is optional: a key left unset falls back to
 * the active baseline, and a key set replaces that default wholesale (per-key, no
 * array concatenation) so a package can opt out with an explicit empty array.
 *
 * The baselines themselves (`DEFAULT_RULES` / `ROOT_DEFAULT_RULES`) deliberately do
 * NOT live here — they are audit POLICY, and policy belongs to the `infra-kit` CLI
 * that enforces it, not to the package a consumer installs to author a config.
 *
 * Most packages need none of these — the standard rules live in the baseline, so
 * a typical config is just `defineConfig(() => ({}))`.
 *
 * @example
 * // infra-kit.config.ts
 * import { defineConfig } from '@slip-stream-kit/config'
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
  /**
   * Explicit override for infra-kit's directory/dependency-based package-type detection (used to
   * pick the agent guidance rendered into this package's `CLAUDE.md`). Detection already covers
   * both consumer repos untouched, so this is an escape hatch for the cases it gets wrong — leaving
   * it unset is never an error.
   *
   * **Ordering precondition:** the CLI's own pinned `packageConfigSchema` — not this package's
   * version — governs what a consumer's `infra-kit.config.ts` may contain, and it is a
   * `z.strictObject`. Only write `type` here once the CLI in use is a version that carries this
   * key; an older CLI rejects the key outright and skips the rest of that package's audit checks.
   *
   * @example
   * // infra-kit.config.ts
   * export default defineConfig(() => ({ type: 'frontend' }))
   */
  type?: InfraKitPackageType
}

/** Package kinds infra-kit's agent guidance renders type-specific rules for. */
export type InfraKitPackageType = 'frontend' | 'backend' | 'lib' | 'e2e' | 'mobile'

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
 * Identity helper that gives `infra-kit.config.ts` authors full type inference
 * and editor autocomplete without changing the value — exactly like Vite's
 * `defineConfig`. Resolution of the factory form happens in the CLI's loader, not here.
 *
 * @example
 * export default defineConfig(() => ({}))
 * @example
 * export default defineConfig(() => ({ requiredScripts: [] }))
 */
export const defineConfig = (config: InfraKitPackageConfigInput): InfraKitPackageConfigInput => {
  return config
}
