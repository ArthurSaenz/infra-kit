import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import type { ConfigRules, ResolvedOptions } from '../types.js'

/**
 * One place for all temporarily-disabled lint rules. The factory appends this LAST so it overrides
 * every layer; definitions stay wired in their own configs (`docs.ts`, `components.ts`) — this only
 * mutes them. To re-enable: delete the line below and un-skip any tests that assert the rule fires
 * (`describe.skip`/`it.skip`; grep the rule id under `__tests__/`).
 *
 * JSDoc rules mute unconditionally (antfu registers the `jsdoc/` plugin regardless of the toggle).
 * `@wl/*` rules are gated on `components` — the `@wl` plugin only loads with that layer, so
 * referencing them otherwise errors.
 */
export const tempDisabledRules = (o: ResolvedOptions): TypedFlatConfigItem => ({
  name: 'wl/temporarily-disabled',
  rules: {
    // Size-gated JSDoc layer — definitions live in `configs/docs.ts`.
    'jsdoc/require-jsdoc': 'off',
    'jsdoc/require-description': 'off',
    'jsdoc/require-example': 'off',
    // `@wl` rules whose definitions come from the recommended preset (`configs/components.ts`). The
    // size rules ship at `error`; `require-jsdoc-example` is bumped to `error` there too (the preset's
    // own default is `warn`). All three are muted here until adoption completes.
    ...(o.components
      ? {
          '@wl/max-jsx-return-size': 'off',
          '@wl/max-components-per-file': 'off',
          '@wl/require-jsdoc-example': 'off',
        }
      : {}),
  } as ConfigRules,
})
