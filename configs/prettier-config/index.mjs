/**
 * Prettier configuration
 *
 * @see https://prettier.io/docs/en/configuration
 *
 * @type {import("prettier").Options}
 */
const config = (options = {}) => {
  const { mode = 'react' } = options

  const basePlugins = ['@trivago/prettier-plugin-sort-imports', 'prettier-plugin-tailwindcss']

  // Add Svelte and Astro plugins if mode is 'astro+svelte'
  if (mode === 'astro+svelte') {
    basePlugins.push('prettier-plugin-svelte', 'prettier-plugin-astro')
  }

  const baseConfig = {
    printWidth: 120,
    tabWidth: 2,
    // useTabs: false,
    semi: false,
    singleQuote: true,
    // jsxSingleQuote: false,
    trailingComma: 'all',
    // bracketSpacing: true,
    // jsxBracketSameLine: false,
    arrowParens: 'always',
    // rangeStart: 0,
    // rangeEnd: Infinity,
    // requirePragma: false,
    // insertPragma: false,
    // proseWrap: 'preserve',
    // htmlWhitespaceSensitivity: 'css',
    // quoteProps: 'as-needed',
    // tailwindFunctions: ['clsx'], // https://github.com/tailwindlabs/prettier-plugin-tailwindcss/blob/main/README.md#sorting-classes-in-template-literals
    endOfLine: 'auto',
    importOrder: [
      '^@pkg/(.*)$',
      '^src/(.*)$',
      '^#root/entities/(.*)$',
      '^#root/features/(.*)$',
      '^#root/components/(.*)$',
      '^#root/lib/(.*)$',
      '^#root/pages/(.*)$',
      '^[./]',
    ],
    importOrderSeparation: true,
    importOrderSortSpecifiers: true,
    plugins: basePlugins,
  }

  // Add overrides for Svelte and Astro files
  if (mode === 'astro+svelte') {
    baseConfig.overrides = [
      {
        files: '*.svelte',
        options: {
          parser: 'svelte',
        },
      },
      {
        files: '*.astro',
        options: {
          parser: 'astro',
        },
      },
    ]
  }

  return baseConfig
}

export default config
