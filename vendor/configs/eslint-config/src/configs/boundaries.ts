import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import boundariesPlugin from 'eslint-plugin-boundaries'

import { GLOB_SRC_ALL } from '../globs.js'
import type { ConfigRules } from '../types.js'

/**
 * Phase 2 — relationship-aware import boundaries via the single modern `boundaries/dependencies`
 * rule (v6 deprecates `entry-point`/`element-types`). Policy:
 *   - sibling cross-imports (feature/service) are TYPE-ONLY — no runtime coupling.
 *   - shared is the runtime exception: features/services may value-import it via its barrel; shared
 *     itself may not depend outward, even on types.
 *   - same-element imports are exempt.
 * Severity is parameterized (default 'warn'; dormant where there's no features/services tree);
 * promote to 'error' after a clean baseline.
 *
 * @example
 * boundaries('error') // stricter; only the rule severity changes
 */
export const boundaries = (severity: 'warn' | 'error' = 'warn'): TypedFlatConfigItem => ({
  files: [GLOB_SRC_ALL],
  plugins: { boundaries: boundariesPlugin },
  settings: {
    // node resolver — no native deps. Consumers using path aliases (`#root` => src) should add their
    // own resolver (e.g. eslint-import-resolver-typescript) so boundaries can classify them.
    'import/resolver': {
      node: { extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'] },
    },
    'boundaries/elements': [
      { type: 'shared', pattern: '**/shared', mode: 'folder' },
      // Feature-nested services must be matched before the generic feature pattern.
      {
        type: 'service',
        pattern: '**/features/*/services/*',
        mode: 'folder',
        capture: ['feature', 'service'],
      },
      { type: 'feature', pattern: '**/features/*', mode: 'folder', capture: ['feature'] },
      { type: 'service', pattern: '**/services/*', mode: 'folder', capture: ['service'] },
    ],
  },
  rules: {
    // Policy is in the header; inline notes mark each `allow` exception.
    'boundaries/dependencies': [
      severity,
      {
        default: 'disallow',
        rules: [
          // VALUE exception: features/services may use shared at runtime, via its barrel only.
          {
            from: { type: ['feature', 'service'] },
            allow: { to: { type: 'shared', internalPath: 'index.{ts,tsx,js,jsx}' } },
          },
          // TYPE-ONLY cross-element imports — the only way siblings reference each other (types are
          // erased at runtime, so no coupling). `from: shared` is absent: shared depends on nothing.
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
