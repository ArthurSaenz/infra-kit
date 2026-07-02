import antfu from '@antfu/eslint-config'
import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import { antfuBaseOptions, overrides, sonarjsRecommended } from './configs/base.js'
import { boundaries } from './configs/boundaries.js'
import { wlComponentsRecommended } from './configs/components.js'
import { jsdoc, markdown } from './configs/docs.js'
import { frameworks } from './configs/frameworks/index.js'
import { ignores } from './configs/ignores.js'
import { tempDisabledRules } from './configs/temp-disabled.js'
import { isKnownMode, resolveOptions } from './options.js'
import type { ConfigOptions } from './types.js'

// Ambient `console` so the dev warning type-checks without pulling in DOM or @types/node.
declare const console: { warn: (...args: unknown[]) => void }

const hasKeys = (obj: object): boolean => Object.keys(obj).length > 0

/**
 * Build the shared flat ESLint config as one `antfu(...)` call; each layer is gated by an option.
 *
 * @example
 * export default createConfig({ mode: 'svelte', boundaries: 'error', ignores: ['dist'] })
 */
export const createConfig = async (userOptions: ConfigOptions = {}): Promise<TypedFlatConfigItem[]> => {
  const o = resolveOptions(userOptions)

  if (!isKnownMode(o.mode)) {
    console.warn(`[@wl/eslint-config] Unknown mode "${o.mode}"; falling back to "react".`)
  }

  const fw = frameworks[o.mode] ?? frameworks.react

  const baseConfig = await antfu(
    { ...antfuBaseOptions, ...fw.antfuFlags },
    sonarjsRecommended,
    overrides,
    ...(o.boundaries === false ? [] : [boundaries(o.boundaries)]),
    ...fw.extraConfigs,
    ...(o.components ? wlComponentsRecommended : []),
    ...(o.jsdoc ? [jsdoc] : []),
    ...(o.markdown ? [markdown] : []),
    // Appended after all rule layers so its `'off'` wins, but before consumer rules so they can override.
    tempDisabledRules(o),
    ignores(o.ignores),
    ...(hasKeys(o.rules) ? [{ rules: o.rules }] : []),
    ...o.userConfigs,
  )

  return baseConfig
}

export default createConfig
