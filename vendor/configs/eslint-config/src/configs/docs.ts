import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import { GLOB_MD, GLOB_TS, GLOB_TS_DOC_EXCLUDE } from '../globs.js'
import type { ConfigRules } from '../types.js'
import { sonarjsRecommended } from './base.js'

/**
 * Function-level JSDoc enforcement was handed off to the custom `@wl/require-jsdoc-example` rule, which
 * applies a graduated cognitive-complexity gate (require a JSDoc block at complexity ≥ 8, require an
 * `@example` at ≥ 12) and is already wired in via that plugin's recommended preset. The three
 * off-the-shelf `jsdoc/*` function-doc rules below are therefore intentionally disabled so the two
 * layers don't double-report. Do NOT re-enable them without first removing the `@wl` rule.
 */
export const jsdoc: TypedFlatConfigItem = {
  files: [GLOB_TS],
  ignores: GLOB_TS_DOC_EXCLUDE,
  rules: {
    'jsdoc/require-jsdoc': 'off',
    'jsdoc/require-description': 'off',
    'jsdoc/require-example': 'off',
  } as ConfigRules,
}

// sonarjs disabled for markdown, derived from the recommended keys so it tracks preset bumps.
export const markdown: TypedFlatConfigItem = {
  files: [GLOB_MD],
  rules: Object.fromEntries(Object.keys(sonarjsRecommended.rules ?? {}).map((rule) => [rule, 'off'])) as ConfigRules,
}
