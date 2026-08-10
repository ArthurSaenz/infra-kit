import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import { GLOB_MD, GLOB_TS, GLOB_TS_DOC_EXCLUDE } from '../globs.js'
import type { ConfigRules } from '../types.js'
import { sonarjsRecommended } from './base.js'

/**
 * These jsdoc/* function-doc rules are off because `@wl/require-jsdoc-example` covers the same ground.
 * Don't re-enable without first removing the @wl rule, or the two layers double-report.
 *
 * The block below adds Layer 1 of the JSDoc size-limits work: off-the-shelf `jsdoc/*` rules that
 * clean up formatting mechanically, ahead of the custom `@wl/max-jsdoc-lines` rule (Layer 2, wired
 * separately once published). Each rule here either autofixes or catches a shape no length cap can:
 *
 * - `tag-lines` (`startLines: 1`) strips blank lines *between* tags but preserves the blank line
 *   separating the block description from its first tag — that separator is house style (see
 *   `vendor/packages/web-toolkit/src/ls-slim/ls-slim.ts`). `startLines: 0` would delete it; verified
 *   empirically, not a guess.
 * - `no-blank-blocks` (fixer on) and `no-multi-asterisks` clean up empty `/** *\/` blocks and stray
 *   `**` lines respectively — both zero-cost autofixes.
 * - `no-types` bans JSDoc type annotations (`@param {string}`) in favor of the TS type itself —
 *   Google's TS style guide bans them outright, and duplicated types drift from the real signature.
 *   It is paired with `require-param-type`/`require-returns-type` set to `'off'`: leaving those on
 *   would flag every block `no-types` just cleaned, since "no type annotation" is what `no-types`
 *   demands and what `require-*-type` forbids being absent. Set explicitly rather than trusting a
 *   preset default, which may not agree.
 * - `check-line-alignment` (`'never'`) bans multi-space column alignment in `@param` tables — those
 *   reflow (and diff) on every rename to a longer identifier.
 * - `informative-docs` is `'warn'`, not `'error'`: verified to have stemming misses (it flags
 *   `/** The user card. *\/` on `UserCard` but not `/** Sets the value. *\/` on `setValue`), so it's a
 *   nudge toward better prose, not a gate that can be trusted to catch every restatement.
 */
export const jsdoc: TypedFlatConfigItem = {
  files: [GLOB_TS],
  ignores: GLOB_TS_DOC_EXCLUDE,
  rules: {
    'jsdoc/require-jsdoc': 'off',
    'jsdoc/require-description': 'off',
    'jsdoc/require-example': 'off',
    'jsdoc/tag-lines': ['error', 'never', { startLines: 1 }],
    'jsdoc/no-blank-blocks': ['error', { enableFixer: true }],
    'jsdoc/no-multi-asterisks': 'error',
    'jsdoc/no-types': 'error',
    'jsdoc/require-param-type': 'off',
    'jsdoc/require-returns-type': 'off',
    'jsdoc/check-line-alignment': ['error', 'never'],
    'jsdoc/informative-docs': 'warn',
  } as ConfigRules,
}

// sonarjs disabled for markdown, derived from the recommended keys so it tracks preset bumps.
export const markdown: TypedFlatConfigItem = {
  files: [GLOB_MD],
  rules: Object.fromEntries(Object.keys(sonarjsRecommended.rules ?? {}).map((rule) => [rule, 'off'])) as ConfigRules,
}
