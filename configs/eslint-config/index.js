import antfu from '@antfu/eslint-config'
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

        //#region Architecture import relation rules
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['*/features/*/*'],
                message:
                  "Importing private modules from a feature is prohibited. Use the feature's public API (index.ts) instead.",
              },
            ],
          },
        ],
        //#endregion Architecture import relation rules
      },
    },
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

    // Temporary disable all sonarjs rules for markdown files
    {
      files: ['**/*.md'],
      rules: Object.fromEntries(Object.keys(sonarjs.configs.recommended.rules).map((rule) => [rule, 'off'])),
    },
    { ignores: ['**/routeTree.gen.ts', '**/citiesOld.json', '**/airports.json', '**/.astro/', ...ignores] },
  )

  return baseConfig
}

export default config
