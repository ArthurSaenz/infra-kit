import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import wl from '@slip-stream-kit/eslint-plugin'

import { GLOB_TS } from '../globs.js'
import type { ConfigRules } from '../types.js'

// White-label component conventions (plugin's recommended preset); some @wl rules are muted in temp-disabled.ts.
export const wlComponentsRecommended: TypedFlatConfigItem[] = [
  ...(wl.configs.recommended as TypedFlatConfigItem[]),
  // Preset ships require-jsdoc-example at `warn`; we bump to `error` (muted in temp-disabled.ts until adoption).
  {
    name: 'wl/require-jsdoc-example-error',
    files: [GLOB_TS],
    rules: { '@wl/require-jsdoc-example': 'error' } as ConfigRules,
  },
]
