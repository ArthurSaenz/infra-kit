import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import { GLOB_SVELTE } from '../../globs.js'
import type { ConfigRules } from '../../types.js'

// Svelte-specific overrides (svelte mode only).
export const svelteConfig: TypedFlatConfigItem = {
  files: [GLOB_SVELTE],
  rules: {
    // Svelte uses 'export let' for props, which is correct
    'import/no-mutable-exports': 'off',
    // Svelte runes like $state() may be used before definition
    'no-use-before-define': 'off',
  } as ConfigRules,
}
