import type { ESLint, Linter } from 'eslint'

import { rules } from './rules'

const PLUGIN_NAME = '@wl'

const plugin: ESLint.Plugin & { configs: Record<string, Linter.Config | Linter.Config[]> } = {
  meta: {
    name: '@wl/eslint-plugin',
    version: '0.1.20',
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
      // Caps component declarations per file; extra components belong in their own
      // files. Pages and routes are excluded (framework conventions co-locate
      // route trees and default-exported page functions). Ceiling confirmed
      // against a repo-wide dry run at the default.
      [`${PLUGIN_NAME}/max-components-per-file`]: ['error', { ignore: ['**/pages/**', '**/routes/**'] }],
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
  // Dumb presentational files (`*-component.tsx`) follow the one-component-per-file
  // convention the props/order/stories rules already assume, so they get a tighter
  // ceiling of 1. This MUST come AFTER the global `**/*.tsx` block: flat config
  // REPLACES rule options across matching blocks (it does not merge), and `ignore`
  // is re-declared here so pages/routes dumb-components keep their exemption.
  // A repo-wide dry run found zero `*-component.tsx` files declaring >1 component.
  {
    files: ['**/*-component.tsx'],
    rules: {
      [`${PLUGIN_NAME}/max-components-per-file`]: [
        'error',
        { maxComponents: 1, ignore: ['**/pages/**', '**/routes/**'] },
      ],
    },
  },
  // `require-jsdoc-example` targets named functions, which overwhelmingly live in
  // plain `.ts` lib/util modules (not just `.tsx`), so it gets its OWN block scoped
  // to both extensions — the tsx-only blocks above would never reach where it
  // matters. Severity is `warn` (not `error`) so first adoption does not break
  // consumers' CI; the graduated defaults (minComplexity 8 → require a JSDoc block,
  // exampleComplexity 12 → also require `@example`) are left implicit. Flat config
  // REPLACES rule options across matching blocks, so this rule lives only here and
  // relies on no option merging.
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      [PLUGIN_NAME]: plugin,
    },
    rules: {
      [`${PLUGIN_NAME}/require-jsdoc-example`]: 'warn',
    },
  },
]

export const meta: ESLint.Plugin['meta'] = plugin.meta
export const configs: Record<string, Linter.Config | Linter.Config[]> = plugin.configs
export { rules }

export default plugin
