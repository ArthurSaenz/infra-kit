import antfu from '@antfu/eslint-config'
import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import { architecture } from './configs/architecture.js'
import { antfuBaseOptions, overrides, sonarjsRecommended, sourceOverrides } from './configs/base.js'
import { boundaries } from './configs/boundaries.js'
import { wlComponentsRecommended } from './configs/components.js'
import { jsdoc, markdown } from './configs/docs.js'
import { e2eBoundaries } from './configs/e2e-boundaries.js'
import { e2ePlaywright } from './configs/e2e-playwright.js'
import { fileNaming } from './configs/file-naming.js'
import { frameworks } from './configs/frameworks/index.js'
import { ignores } from './configs/ignores.js'
import { shadcnConfig } from './configs/shadcn.js'
import { tempDisabledRules } from './configs/temp-disabled.js'
import { isKnownMode, resolveOptions } from './options.js'
import type { ConfigOptions } from './types.js'

// Ambient `console` so the dev warning type-checks without pulling in DOM or @types/node.
declare const console: { warn: (...args: unknown[]) => void }

const hasKeys = (obj: object): boolean => Object.keys(obj).length > 0

// Layers are module-level objects that also share glob lists with each other: copy what a consumer
// might mutate on the returned config, so the edit cannot leak into a sibling block or a later call.
const fresh = (item: TypedFlatConfigItem): TypedFlatConfigItem => ({
  ...item,
  ...(item.files && { files: [...item.files] }),
  ...(item.ignores && { ignores: [...item.ignores] }),
  ...(item.rules && { rules: structuredClone(item.rules) }),
})

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

  const fw = isKnownMode(o.mode) ? frameworks[o.mode] : frameworks.react

  const layers: TypedFlatConfigItem[] = [
    sonarjsRecommended,
    overrides,
    sourceOverrides,
    // e2e after the app layer: for files of a Playwright package its elements replace features/services/shared.
    ...(o.boundaries === false ? [] : [boundaries(o.boundaries), e2eBoundaries(o.boundaries)]),
    e2ePlaywright(),
    ...fw.extraConfigs,
    ...(o.architecture && fw.architecture ? architecture(o.restrictedSyntax) : []),
    ...(o.components ? wlComponentsRecommended : []),
    ...(o.jsdoc ? [jsdoc] : []),
    ...(o.markdown ? [markdown] : []),
    ...(o.shadcn ? [shadcnConfig] : []),
    ...(o.fileNaming ? [fileNaming] : []),
    // Appended after all rule layers so its `'off'` wins, but before consumer rules so they can override.
    tempDisabledRules(o),
    ignores(o.ignores),
  ]

  const baseConfig = await antfu(
    { ...antfuBaseOptions, ...fw.antfuFlags },
    ...layers.map(fresh),
    ...(hasKeys(o.rules) ? [{ rules: o.rules }] : []),
    ...o.userConfigs,
  )

  return baseConfig
}

export default createConfig
