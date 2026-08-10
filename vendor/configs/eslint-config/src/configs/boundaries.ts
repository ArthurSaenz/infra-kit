import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import boundariesPlugin from 'eslint-plugin-boundaries'
import { fileURLToPath } from 'node:url'

import { GLOB_SRC_ALL } from '../globs.js'
import type { ConfigRules } from '../types.js'

/**
 * Absolute path to the bundled `#root/*` resolver. `eslint-module-utils` loads resolvers with
 * `require(name)` and accepts no object, so the settings key must be requirable.
 *
 * An absolute path rather than the package subpath `@wl/eslint-config/resolvers/root-alias.cjs`:
 * the subpath is resolved against the *linted file*, so it only works where that file can reach
 * `@wl/eslint-config` through node_modules. An absolute path resolves identically from anywhere,
 * including fixture trees outside any package. Resolved from this module, so it is correct from
 * both `src/configs/` and `dist/configs/` — the depth to the package root is the same.
 */
const ROOT_ALIAS_RESOLVER = fileURLToPath(new URL('../../resolvers/root-alias.cjs', import.meta.url))

/**
 * Relationship-aware import boundaries: sibling feature/service imports are type-only; shared is the
 * runtime exception (value-import via its barrel only). Severity is parameterized (default 'error').
 *
 * Keep this default in step with `resolveOptions` in options.ts — the factory always passes an
 * explicit severity, so a disagreement here would only surface for direct callers.
 *
 * @example
 * boundaries('warn') // advisory; note `eslint --quiet` hides warnings entirely
 */
export const boundaries = (severity: 'warn' | 'error' = 'error'): TypedFlatConfigItem => ({
  files: [GLOB_SRC_ALL],
  plugins: { boundaries: boundariesPlugin },
  settings: {
    // `#root/*` resolver first — without it an aliased `#root/features/other` import does not
    // resolve and the violation is silently missed (exit 0), while the same import written
    // relatively is caught. It is keyed by absolute path because `eslint-module-utils` loads
    // resolvers by name via `require()` and cannot take an object. Node resolver stays as the
    // fallback for plain relative and package specifiers.
    'import/resolver': {
      [ROOT_ALIAS_RESOLVER]: {},
      node: { extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'] },
    },
    // Do not re-add `mode: 'folder'` — it is the v7 default and passing it explicitly is deprecated.
    //
    // `capture` names wildcard segments POSITIONALLY, and the leading `**` is a segment. Naming
    // only `['feature']` therefore bound the name to `**` — which is empty at src root — and left
    // the actual folder unnamed, so every violation message read `feature=""` on both sides and
    // told you nothing about which features were involved. Naming the `**` slot first restores
    // `feature="booking" to feature="billing"`.
    'boundaries/elements': [
      { type: 'shared', pattern: '**/shared' },
      // Feature-nested services must be matched before the generic feature pattern: with
      // `boundaries/elements-single-type` (v7 default), the first matching descriptor wins.
      {
        type: 'service',
        pattern: '**/features/*/services/*',
        capture: ['base', 'feature', 'service'],
      },
      { type: 'feature', pattern: '**/features/*', capture: ['base', 'feature'] },
      { type: 'service', pattern: '**/services/*', capture: ['base', 'service'] },
    ],
  },
  rules: {
    'boundaries/dependencies': [
      severity,
      {
        default: 'disallow',
        // Selectors are wrapped in `element: {…}` — the v6+ entity-selector form. A bare
        // `{ type: 'feature' }` still works via backward compatibility but makes the plugin
        // log "Detected legacy selector syntax" on every run.
        policies: [
          // VALUE exception: feature/service -> shared at runtime, barrel only.
          {
            from: { element: { type: ['feature', 'service'] } },
            allow: { to: { element: { type: 'shared', fileInternalPath: 'index.{ts,tsx,js,jsx}' } } },
          },
          // TYPE-ONLY cross-element imports (erased at runtime). shared is absent here: it depends on nothing.
          {
            from: { element: { type: ['feature', 'service'] } },
            dependency: { kind: 'type' },
            allow: { to: { element: { type: ['feature', 'service', 'shared'] } } },
          },
        ],
      },
    ],
  } as ConfigRules,
})
