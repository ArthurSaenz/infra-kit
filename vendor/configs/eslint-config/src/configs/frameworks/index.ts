import type { OptionsConfig, TypedFlatConfigItem } from '@antfu/eslint-config'

import { svelteConfig } from './svelte.js'

/** A framework preset: antfu option flags + any extra positional configs to splice into the call. */
export interface FrameworkPreset {
  /** Flags merged onto base antfu options (e.g. `{ react: true }`), typed so a typo is a compile error. */
  antfuFlags: Partial<OptionsConfig>
  /** Extra flat-configs spliced in at the framework position (after boundaries, before components). */
  extraConfigs: TypedFlatConfigItem[]
}

/** Framework registry — the single seam for adding a mode. The factory looks up by `mode`, falling back to `react`. */
export const frameworks: Record<string, FrameworkPreset> = {
  react: { antfuFlags: { react: true }, extraConfigs: [] },
  svelte: { antfuFlags: { svelte: true }, extraConfigs: [svelteConfig] },
}
