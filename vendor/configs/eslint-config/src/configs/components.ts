import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import wl from '@slip-stream-kit/eslint-plugin'

import { GLOB_TS } from '../globs.js'
import type { ConfigRules } from '../types.js'

// White-label component-file conventions, from the plugin's `configs.recommended` preset. Some @wl
// rules are muted in `configs/temp-disabled.ts`, not here.
export const wlComponentsRecommended: TypedFlatConfigItem[] = [
  ...(wl.configs.recommended as TypedFlatConfigItem[]),
  // The preset ships `@wl/require-jsdoc-example` at `warn` for soft, non-breaking adoption; we enforce
  // it at `error` to match the other @wl rules. It is currently muted in `configs/temp-disabled.ts`
  // until adoption completes — the `error` severity here is the intended state once that mute is lifted.
  {
    name: 'wl/require-jsdoc-example-error',
    files: [GLOB_TS],
    rules: { '@wl/require-jsdoc-example': 'error' } as ConfigRules,
  },
]
