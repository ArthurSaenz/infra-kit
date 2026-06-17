import antfu from '@antfu/eslint-config'
import boundaries from 'eslint-plugin-boundaries'
// import wl from '@slip-stream-kit/eslint-plugin'
import sonarjs from 'eslint-plugin-sonarjs'

const config = async (userOptions = {}) => {
  const { mode = 'react', ignores = [] } = userOptions

  const antfuOptions = { lessOpinionated: true }

  if (mode === 'svelte') {
    antfuOptions.svelte = true
  } else {
    antfuOptions.react = true
  }

  const baseConfig = await antfu(
    antfuOptions,
    sonarjs.configs.recommended,
    {
      rules: {
        'antfu/top-level-function': 'off',
        'antfu/consistent-chaining': 'off',

        'react/prefer-shorthand-boolean': 'off',

        // TEMPORARY DISABLED RULES
        'react/component-hook-factories': 'off',
        'react/rules-of-hooks': 'off',
        'react/unsupported-syntax': 'off',

        'react-refresh/only-export-components': 'off',

        'perfectionist/sort-imports': 'off',
        'style/arrow-parens': ['error', 'always'],
        'arrow-body-style': ['error', 'always'],

        // Temporary disable
        'ts/no-use-before-define': 'off',

        'perfectionist/sort-named-imports': 'off',

        'e18e/prefer-static-regex': 'off',
        'e18e/prefer-array-from-map': 'off',

        'style/padding-line-between-statements': [
          'error',
          { blankLine: 'always', prev: '*', next: 'return' },
          { blankLine: 'always', prev: ['const', 'let'], next: '*' },
          { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        ],
        'style/jsx-one-expression-per-line': 'off',
        'style/brace-style': 'off',
        'style/member-delimiter-style': 'off',
        'style/multiline-ternary': 'off',
        'style/operator-linebreak': 'off', // TODO
        'style/quote-props': 'off',
        'style/jsx-wrap-multilines': 'off',
        'style/indent-binary-ops': 'off',
        'style/indent': 'off',
        'style/jsx-wrap-multilines': 'off',
        'style/indent-binary-ops': 'off',
        'style/jsx-curly-newline': 'off',
        'style/quotes': 'off',

        curly: 'off',

        'sonarjs/fixme-tag': 'warn',
        'sonarjs/todo-tag': 'warn',
        'sonarjs/mouse-events-a11y': 'off',
        'sonarjs/no-array-index-key': 'off',

        'sonarjs/no-commented-code': 'off', // TODO: temporary disable, must be enabled

        'unicorn/no-new-array': 'off',

        // prettier owns numeric-literal formatting (lowercases hex), which conflicts with
        // unicorn/number-literal-case (wants uppercase hex digits). Let prettier win.
        'unicorn/number-literal-case': 'off',

        //#region Architecture import relation rules
        // Enforce public-API boundaries: features/services must be imported via their barrel
        // (index.ts), never their internals. `**/<kind>/*/**` anchors on the segment (not a
        // leading-segment count), so it matches every prefix (#root/, @/, src/, ../) at any
        // depth, while the trailing `/**` requires >=1 inner segment — keeping the barrel allowed.
        // String-only: bans deep imports but can't detect cross-element relationships (feature A
        // -> feature B); that is gated Phase 2, see .omc/plans/eslint-import-boundary-rules.md.
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/features/*/**'],
                message:
                  "Importing private modules from a feature is prohibited. Use the feature's public API (index.ts) instead.",
              },
              {
                group: ['**/services/*/**'],
                message:
                  "Importing private modules from a service is prohibited. Use the service's public API (index.ts) instead.",
              },
            ],
          },
        ],
        //#endregion Architecture import relation rules
      },
    },

    //#region Phase 2 — relationship-aware import boundaries (eslint-plugin-boundaries)
    // Where Phase 1's `no-restricted-imports` is string-only (blind to the importer's
    // location), this layer resolves each import, classifies both ends as an architectural
    // element (feature / service / shared) and enforces RELATIONSHIPS via the single modern
    // `boundaries/dependencies` rule (v6 deprecates `entry-point`/`element-types`):
    //   - sibling cross-imports are TYPE-ONLY: feature<->feature / service<->service /
    //     feature<->service may reference each other only via `import type` (no runtime
    //     coupling). Value cross-imports between siblings are disallowed.
    //   - shared is the one runtime exception: features/services may import `shared` at value
    //     level through its barrel. `shared` itself may not depend outward (not even types).
    //   - same-element imports are exempt (checkInternals=false).
    // Runs at WARN until a real features/services tree adopts it (promote to error after a
    // clean baseline); dormant on packages without such a tree (their files are `unknown`).
    // Real consumers importing via the `#root` alias (=> src) need the resolver below to
    // classify aliased targets; fixtures use relative imports. See README + the plan.
    {
      files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
      plugins: { boundaries },
      settings: {
        // Resolve TS sources via the node resolver (bundled with the plugin) — no native
        // deps. Real consumers using path aliases (e.g. `#root` => src) should add their own
        // resolver (e.g. eslint-import-resolver-typescript) so boundaries can classify them.
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
        // Single modern rule (v6; `entry-point`/`element-types` are deprecated). Policy:
        // cross-element imports between SIBLINGS (feature<->feature, service<->service,
        // feature<->service) must be TYPE-ONLY — no runtime/value cross-import. The one
        // runtime exception is the shared layer: features/services may import `shared` at
        // value level through its barrel. `shared` may not depend outward at all (no rule),
        // so shared -> feature/service is disallowed for both value AND type. Intra-element
        // imports are exempt (checkInternals=false).
        'boundaries/dependencies': [
          'warn',
          {
            default: 'disallow',
            rules: [
              // VALUE exception: features/services may use the shared layer at runtime,
              // through its barrel only (deep value imports into shared stay disallowed).
              {
                from: { type: ['feature', 'service'] },
                allow: { to: { type: 'shared', internalPath: 'index.{ts,tsx,js,jsx}' } },
              },
              // TYPE-ONLY cross-element imports (any path) are allowed for features/services —
              // this is the only way siblings may reference each other. Types are erased at
              // runtime, so they create no runtime coupling. `from: shared` is intentionally
              // absent: shared must not depend on features/services even for types.
              {
                from: { type: ['feature', 'service'] },
                dependency: { kind: 'type' },
                allow: { to: { type: ['feature', 'service', 'shared'] } },
              },
            ],
          },
        ],
      },
    },
    //#endregion Phase 2 — relationship-aware import boundaries

    mode === 'svelte'
      ? [
          {
            files: ['**/*.svelte'],
            rules: {
              // Svelte uses 'export let' for props, which is correct
              'import/no-mutable-exports': 'off',
              // Svelte runes like $state() may be used before definition
              'no-use-before-define': 'off',
            },
          },
        ]
      : [],

    // White-label architecture rules: props destructuring + component file order
    // wl.configs.recommended,

    // Temporary disable all sonarjs rules for markdown files
    {
      files: ['**/*.md'],
      rules: Object.fromEntries(Object.keys(sonarjs.configs.recommended.rules).map((rule) => [rule, 'off'])),
    },
    {
      ignores: ['**/routeTree.gen.ts', '**/citiesOld.json', '**/airports.json', '**/.astro/', '**/.omc/**', ...ignores],
    },
  )

  return baseConfig
}

export default config
