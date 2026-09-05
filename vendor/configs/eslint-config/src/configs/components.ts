import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import wl from '@slip-stream-kit/eslint-plugin'

import { GLOB_TS, GLOB_TS_DOC_EXCLUDE } from '../globs.js'
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
  // Layer 2 of the JSDoc size-limits work (Layer 1 is the `jsdoc/*` block in configs/docs.ts): caps a
  // block's prose and its `@example` bodies against two independent budgets (defaults 15 / 10 lines),
  // with `@fileoverview` as the only escape hatch. The preset leaves it off and the plugin readme
  // suggests `warn`; it is wired here at `error`, because a cap nobody has to satisfy is not a cap.
  // It lives in this layer rather than docs.ts because the @wl plugin only loads here, but it takes
  // the JSDoc layer's scope — tests, stories and declarations stay exempt, exactly as they are there.
  {
    name: 'wl/max-jsdoc-lines-error',
    files: [GLOB_TS],
    ignores: GLOB_TS_DOC_EXCLUDE,
    rules: { '@wl/max-jsdoc-lines': 'error' } as ConfigRules,
  },
]
