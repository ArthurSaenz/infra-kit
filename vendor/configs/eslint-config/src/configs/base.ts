import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import type { Linter } from 'eslint'
import sonarjs from 'eslint-plugin-sonarjs'

import type { ConfigRules } from '../types.js'

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

    'react/component-hook-factories': 'off',
    'react/rules-of-hooks': 'off',
    'react/unsupported-syntax': 'off',

    'react-refresh/only-export-components': 'off',

    'perfectionist/sort-imports': 'off',
    'style/arrow-parens': ['error', 'always'],
    'arrow-body-style': ['error', 'always'],

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

    'sonarjs/no-commented-code': 'off',

    'unicorn/no-new-array': 'off',

    // prettier lowercases hex literals; let it win over unicorn/number-literal-case.
    'unicorn/number-literal-case': 'off',

    // Public-API boundary: feature/service internals are blocked; the `!**/index*` negations re-include
    // the barrel (gitignore glob semantics). Cross-element relations are the Phase-2 boundaries layer.
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/features/*/**', '!**/features/*/index', '!**/features/*/index.*'],
            message:
              "Importing private modules from a feature is prohibited. Use the feature's public API (index.ts) instead.",
          },
          {
            group: ['**/services/*/**', '!**/services/*/index', '!**/services/*/index.*'],
            message:
              "Importing private modules from a service is prohibited. Use the service's public API (index.ts) instead.",
          },
        ],
      },
    ],
  } as ConfigRules,
}
