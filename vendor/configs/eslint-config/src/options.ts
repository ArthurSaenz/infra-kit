import { frameworks } from './configs/frameworks/index.js'
import type { ConfigOptions, ResolvedOptions } from './types.js'

/** A mode is "known" iff it's in the framework registry (the single source of truth for modes). */
export const isKnownMode = (mode: string): boolean => {
  return mode in frameworks
}

/**
 * Normalize user options to a fully-resolved shape (defaults: react, boundaries 'warn', every layer on).
 *
 * @example
 * resolveOptions({ boundaries: false }) // boundaries layer dropped, everything else default
 */
export const resolveOptions = (userOptions: ConfigOptions = {}): ResolvedOptions => {
  const { mode, ignores, boundaries, jsdoc, markdown, components, rules, userConfigs } = userOptions

  return {
    mode: mode ?? 'react',
    ignores: ignores ?? [],
    boundaries: boundaries === undefined ? 'warn' : boundaries === true ? 'warn' : boundaries,
    jsdoc: jsdoc ?? true,
    markdown: markdown ?? true,
    components: components ?? true,
    rules: rules ?? {},
    userConfigs: userConfigs ?? [],
  }
}
