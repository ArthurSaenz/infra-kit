import type { TypedFlatConfigItem } from '@antfu/eslint-config'

/** Rule map accepted by a flat-config item (antfu's typed rules, kept loose for plugin rules). */
export type ConfigRules = TypedFlatConfigItem['rules']

export interface ConfigOptions {
  /** Framework preset. Default 'react'; unknown values fall back to 'react'. */
  mode?: 'react' | 'svelte' | (string & {})
  /** Extra ignore globs appended to the built-in ignores. */
  ignores?: string[]
  /** Import boundaries. Default 'warn'; `false` drops the layer, `true` === 'warn', 'error' enforces. */
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
