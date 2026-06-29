import type { TypedFlatConfigItem } from '@antfu/eslint-config'

/** Rule map accepted by a flat-config item (antfu's typed rules, kept loose for plugin rules). */
export type ConfigRules = TypedFlatConfigItem['rules']

export interface ConfigOptions {
  /**
   * Framework preset. Default 'react'. Open union for forward-compat: an unknown value falls back
   * to 'react' (with a dev-time console.warn). Add new presets in `configs/frameworks/index.ts`.
   */
  mode?: 'react' | 'svelte' | (string & {})
  /** Extra ignore globs appended to the built-in ignores. */
  ignores?: string[]
  /**
   * Architecture import boundaries (Phase 2, relationship-aware). Default 'warn'.
   * `false` drops the layer; `true` === 'warn'; 'error' enforces strictly.
   * (Phase 1 — the string-based public-API guard — is always on; it lives in the base overrides.)
   */
  boundaries?: boolean | 'warn' | 'error'
  /** Size-gated JSDoc layer. Default true. */
  jsdoc?: boolean
  /** Markdown sonarjs-off layer. Default true. */
  markdown?: boolean
  /** White-label component-convention layer (@wl). Default true. */
  components?: boolean
  /** Consumer rule overrides, merged LAST (highest precedence). Omitted from the call when empty. */
  rules?: ConfigRules
  /** Arbitrary consumer flat-configs appended LAST. Empty by default. */
  userConfigs?: TypedFlatConfigItem[]
}

/** Fully-resolved options with every default applied. Produced by `resolveOptions`. */
export interface ResolvedOptions {
  mode: string
  ignores: string[]
  boundaries: false | 'warn' | 'error'
  jsdoc: boolean
  markdown: boolean
  components: boolean
  rules: NonNullable<ConfigRules>
  userConfigs: TypedFlatConfigItem[]
}
