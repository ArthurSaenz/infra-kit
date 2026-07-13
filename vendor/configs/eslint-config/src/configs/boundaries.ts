import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import boundariesPlugin from 'eslint-plugin-boundaries'

import { GLOB_SRC_ALL } from '../globs.js'
import type { ConfigRules } from '../types.js'

/**
 * Relationship-aware import boundaries: sibling feature/service imports are type-only; shared is the
 * runtime exception (value-import via its barrel only). Severity is parameterized (default 'warn').
 *
 * @example
 * boundaries('error') // stricter; only the rule severity changes
 */
export const boundaries = (severity: 'warn' | 'error' = 'warn'): TypedFlatConfigItem => ({
  files: [GLOB_SRC_ALL],
  plugins: { boundaries: boundariesPlugin },
  settings: {
    // node resolver; consumers using path aliases must add their own (e.g. eslint-import-resolver-typescript).
    'import/resolver': {
      node: { extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'] },
    },
    // Do not re-add `mode: 'folder'` — it is the v7 default and passing it explicitly is deprecated.
    'boundaries/elements': [
      { type: 'shared', pattern: '**/shared' },
      // Feature-nested services must be matched before the generic feature pattern: with
      // `boundaries/elements-single-type` (v7 default), the first matching descriptor wins.
      {
        type: 'service',
        pattern: '**/features/*/services/*',
        capture: ['feature', 'service'],
      },
      { type: 'feature', pattern: '**/features/*', capture: ['feature'] },
      { type: 'service', pattern: '**/services/*', capture: ['service'] },
    ],
  },
  rules: {
    'boundaries/dependencies': [
      severity,
      {
        default: 'disallow',
        policies: [
          // VALUE exception: feature/service -> shared at runtime, barrel only.
          {
            from: { type: ['feature', 'service'] },
            allow: { to: { type: 'shared', fileInternalPath: 'index.{ts,tsx,js,jsx}' } },
          },
          // TYPE-ONLY cross-element imports (erased at runtime). shared is absent here: it depends on nothing.
          {
            from: { type: ['feature', 'service'] },
            dependency: { kind: 'type' },
            allow: { to: { type: ['feature', 'service', 'shared'] } },
          },
        ],
      },
    ],
  } as ConfigRules,
})
