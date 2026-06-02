import type { ESLint, Linter } from 'eslint'

import { rules } from './rules'

const PLUGIN_NAME = '@wl'

const plugin: ESLint.Plugin & { configs: Record<string, Linter.Config> } = {
  meta: {
    name: '@wl/eslint-plugin',
    version: '0.1.0',
  },
  rules,
  configs: {},
}

/**
 * Flat-config preset that registers the plugin and turns every rule on.
 *
 * @example
 * import wl from '@wl/eslint-plugin'
 *
 * export default [wl.configs.recommended]
 */
plugin.configs.recommended = {
  plugins: {
    [PLUGIN_NAME]: plugin,
  },
  rules: {
    [`${PLUGIN_NAME}/props-destructuring-newline`]: 'error',
    [`${PLUGIN_NAME}/props-destructuring-blank-line`]: 'error',
    [`${PLUGIN_NAME}/component-file-order`]: 'error',
  },
}

export const meta: ESLint.Plugin['meta'] = plugin.meta
export const configs: Record<string, Linter.Config> = plugin.configs
export { rules }

export default plugin
