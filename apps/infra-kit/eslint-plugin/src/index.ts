import type { ESLint, Linter } from 'eslint'

import { rules } from './rules'

const PLUGIN_NAME = '@wl'

const plugin: ESLint.Plugin & { configs: Record<string, Linter.Config | Linter.Config[]> } = {
  meta: {
    name: '@wl/eslint-plugin',
    version: '0.1.14',
  },
  rules,
  configs: {},
}

/**
 * Flat-config preset that registers the plugin and turns every rule on, scoped to
 * the files each rule is meant for. It is an array of config blocks, so spread it:
 *
 * @example
 * import wl from '@wl/eslint-plugin'
 *
 * export default [...wl.configs.recommended]
 */
plugin.configs.recommended = [
  {
    files: ['**/*.tsx'],
    plugins: {
      [PLUGIN_NAME]: plugin,
    },
    rules: {
      [`${PLUGIN_NAME}/props-destructuring-newline`]: 'error',
      [`${PLUGIN_NAME}/props-destructuring-blank-line`]: 'error',
      [`${PLUGIN_NAME}/props-type-reference`]: 'error',
      [`${PLUGIN_NAME}/props-type-name`]: 'error',
      [`${PLUGIN_NAME}/component-file-order`]: 'error',
      // Pages and routes are excluded: route/page modules commonly use `function`
      // declarations (and framework conventions like default-exported page functions).
      [`${PLUGIN_NAME}/component-arrow-function`]: ['error', { ignore: ['**/pages/**', '**/routes/**'] }],
      [`${PLUGIN_NAME}/require-component-stories`]: 'error',
      // Advisory: flags returns that render too many JSX elements; extract into a
      // variable or sub-component. Warn-class by nature (`type: 'suggestion'`);
      // severity confirmed against a repo-wide dry run at the default ceiling.
      [`${PLUGIN_NAME}/max-jsx-return-size`]: 'error',
    },
  },
  // Storybook stories legitimately deviate from the component conventions: the
  // imports → *Props → component order (meta/args/decorators/render fns), and
  // named templates that reference the *component's* props type (e.g.
  // `const Template = (args: ButtonProps) => ...`) rather than their own
  // `<TemplateName>Props`. So both the ordering and the props-type-name rules
  // would only produce noise there. Every other rule stays enabled for stories.
  {
    files: ['**/*.stories.{ts,tsx}'],
    rules: {
      [`${PLUGIN_NAME}/component-file-order`]: 'off',
      [`${PLUGIN_NAME}/props-type-name`]: 'off',
    },
  },
]

export const meta: ESLint.Plugin['meta'] = plugin.meta
export const configs: Record<string, Linter.Config | Linter.Config[]> = plugin.configs
export { rules }

export default plugin
