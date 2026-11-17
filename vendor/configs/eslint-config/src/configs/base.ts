import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import type { Linter } from 'eslint'
import sonarjs from 'eslint-plugin-sonarjs'

import { GLOB_SRC_ALL, GLOB_SVELTE } from '../globs.js'
import type { ConfigRules } from '../types.js'

/**
 * Public-API boundary: feature/service internals are blocked; the negated `index` globs re-include the barrel
 * (gitignore glob semantics). Exported because a later `no-restricted-imports` block replaces these options
 * rather than merging, so it has to repeat them.
 */
export const publicApiPatterns = [
  {
    group: ['**/features/*/**', '!**/features/*/index', '!**/features/*/index.*'],
    message: "Importing private modules from a feature is prohibited. Use the feature's public API (index.ts) instead.",
  },
  {
    group: ['**/services/*/**', '!**/services/*/index', '!**/services/*/index.*'],
    message: "Importing private modules from a service is prohibited. Use the service's public API (index.ts) instead.",
  },
  {
    // `\#`: gitignore syntax reads a leading `#` as a comment. Anchored on `#root/` (= src/) because a bare
    // `**/lib/*/**` would also block package subpaths like `highlight.js/lib/…`.
    group: ['\\#root/lib/*/**', '!\\#root/lib/*/index', '!\\#root/lib/*/index.*'],
    message:
      "Importing private modules from a lib module is prohibited. Use the module's public API (index.ts) instead.",
  },
]

/** Base antfu options shared by every mode. Framework flags (react/svelte) are merged in the factory. */
export const antfuBaseOptions = { lessOpinionated: true }

/** sonarjs recommended preset. Composed early so later layers can override its rules. */
export const sonarjsRecommended: Linter.Config = sonarjs.configs.recommended

/** Project-wide rule overrides, applied after antfu + sonarjs so these win; consumer rules win over these. */
export const overrides: TypedFlatConfigItem = {
  rules: {
    'antfu/top-level-function': 'off',
    'antfu/consistent-chaining': 'off',

    'react/prefer-shorthand-boolean': 'off',

    // component-hook-factories and unsupported-syntax: "temporary" in the imported config (f9657f1),
    // reason unrecorded. rules-of-hooks crashes on real code; configs/architecture.ts runs the official
    // react-hooks plugin's rule instead.
    'react/component-hook-factories': 'off',
    'react/rules-of-hooks': 'off',
    'react/unsupported-syntax': 'off',

    // Re-enabled for `.tsx` outside route shells in configs/architecture.ts.
    'react-refresh/only-export-components': 'off',

    'perfectionist/sort-imports': 'off',
    'style/arrow-parens': ['error', 'always'],
    'arrow-body-style': ['error', 'always'],

    // "Temporary" in the imported config (f9657f1), reason unrecorded.
    'ts/no-use-before-define': 'off',

    'perfectionist/sort-named-imports': 'off',

    'e18e/prefer-static-regex': 'off',
    'e18e/prefer-array-from-map': 'off',

    'style/padding-line-between-statements': [
      'error',
      { blankLine: 'always', prev: '*', next: 'return' },
      { blankLine: 'always', prev: ['const', 'let'], next: '*' },
      { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
      // Later entries win, so these carve multi-line declarations out of the `any` above.
      { blankLine: 'always', prev: ['singleline-const', 'singleline-let'], next: ['multiline-const', 'multiline-let'] },
      { blankLine: 'always', prev: ['multiline-const', 'multiline-let'], next: '*' },
    ],
    'style/jsx-one-expression-per-line': 'off',
    'style/brace-style': 'off',
    'style/member-delimiter-style': 'off',
    'style/multiline-ternary': 'off',
    'style/operator-linebreak': 'off',
    'style/quote-props': 'off',
    'style/jsx-wrap-multilines': 'off',
    'style/indent-binary-ops': 'off',
    'style/indent': 'off',
    'style/jsx-curly-newline': 'off',
    'style/quotes': 'off',

    curly: 'off',

    'sonarjs/fixme-tag': 'warn',
    'sonarjs/todo-tag': 'warn',
    'sonarjs/mouse-events-a11y': 'off',
    'sonarjs/no-array-index-key': 'off',

    // "Temporary, must be enabled" in the imported config (f9657f1).
    'sonarjs/no-commented-code': 'off',

    'unicorn/no-new-array': 'off',

    // prettier lowercases hex literals; let it win over unicorn/number-literal-case.
    'unicorn/number-literal-case': 'off',

    'no-restricted-imports': ['error', { patterns: publicApiPatterns }],
  } as ConfigRules,
}

/**
 * Rules turned ON, scoped to code: a rule that is on must support every language its block matches, and the
 * unscoped `overrides` block also matches the JSON/YAML files antfu lints (`rules do not support the language`).
 */
export const sourceOverrides: TypedFlatConfigItem = {
  files: [GLOB_SRC_ALL, GLOB_SVELTE],
  rules: {
    'unicorn/no-for-each': 'error',
  },
}
