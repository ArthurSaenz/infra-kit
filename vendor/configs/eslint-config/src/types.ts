import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import type { RestrictedSyntax } from './configs/architecture.js'

/** Rule map accepted by a flat-config item (antfu's typed rules, kept loose for plugin rules). */
export type ConfigRules = TypedFlatConfigItem['rules']

export interface ConfigOptions {
  /** Framework preset. Default 'react'; unknown values fall back to 'react'. */
  mode?: 'react' | 'svelte' | (string & {})
  /** Extra ignore globs appended to the built-in ignores. */
  ignores?: string[]
  /** Import boundaries. Default 'error'; `false` drops the layer, `true` === 'error', 'warn' downgrades. */
  boundaries?: boolean | 'warn' | 'error'
  /** Size-gated JSDoc layer. Default true. */
  jsdoc?: boolean
  /** Markdown sonarjs-off layer. Default true. */
  markdown?: boolean
  /** White-label component-convention layer (@wl). Default true. */
  components?: boolean
  /** Tailwind design-system rules (@shadcn/lint). Default true. */
  shadcn?: boolean
  /** fe-architect layer: rules of hooks, platform access, dumb-component imports. React mode only. Default true. */
  architecture?: boolean
  /** Extra `no-restricted-syntax` entries for frontend code, appended to the shared ones. */
  restrictedSyntax?: RestrictedSyntax[]
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
  shadcn: boolean
  architecture: boolean
  restrictedSyntax: RestrictedSyntax[]
  rules: NonNullable<ConfigRules>
  userConfigs: TypedFlatConfigItem[]
}
