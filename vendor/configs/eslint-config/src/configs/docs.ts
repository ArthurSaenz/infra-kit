import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import { GLOB_MD, GLOB_TS, GLOB_TS_DOC_EXCLUDE } from '../globs.js'
import type { ConfigRules } from '../types.js'
import { sonarjsRecommended } from './base.js'

/**
 * These jsdoc/* function-doc rules are off because `@wl/require-jsdoc-example` covers the same ground.
 * Don't re-enable without first removing the @wl rule, or the two layers double-report.
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
