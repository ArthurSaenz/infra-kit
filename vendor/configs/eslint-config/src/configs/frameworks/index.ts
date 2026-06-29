import type { OptionsConfig, TypedFlatConfigItem } from '@antfu/eslint-config'

import { svelteConfig } from './svelte.js'

/** A framework preset: antfu option flags + any extra positional configs to splice into the call. */
export interface FrameworkPreset {
  /** Flags merged onto the base antfu options (e.g. `{ react: true }`). Typed against antfu's own
   *  options so a misspelled flag (`{ reactt: true }`) is a compile error, not a silent no-op. */
  antfuFlags: Partial<OptionsConfig>
  /** Extra flat-configs spliced in at the framework position (after boundaries, before components). */
  extraConfigs: TypedFlatConfigItem[]
}

/**
 * Framework registry — the single seam for adding a mode: drop a `configs/frameworks/<name>.ts` and
 * add an entry here. The factory looks the preset up by `mode`, falling back to `react`.
 */
export const frameworks: Record<string, FrameworkPreset> = {
  react: { antfuFlags: { react: true }, extraConfigs: [] },
  svelte: { antfuFlags: { svelte: true }, extraConfigs: [svelteConfig] },
}
