import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import type { ConfigRules, ResolvedOptions } from '../types.js'

/**
 * Central mute list, appended LAST so it overrides every layer (definitions stay in their own configs).
 * JSDoc rules mute unconditionally; @wl rules are gated on `components` (the plugin only loads there).
 */
export const tempDisabledRules = (o: ResolvedOptions): TypedFlatConfigItem => ({
  name: 'wl/temporarily-disabled',
  rules: {
    // JSDoc layer — defined in configs/docs.ts.
    'jsdoc/require-jsdoc': 'off',
    'jsdoc/require-description': 'off',
    'jsdoc/require-example': 'off',
    // @wl rules (defined in configs/components.ts), muted here until adoption completes.
    ...(o.components
      ? {
          '@wl/max-jsx-return-size': 'off',
          '@wl/max-components-per-file': 'off',
          '@wl/require-jsdoc-example': 'off',
        }
      : {}),
  } as ConfigRules,
})
