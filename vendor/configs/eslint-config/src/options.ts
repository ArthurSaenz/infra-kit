import { frameworks } from './configs/frameworks/index.js'
import type { ConfigOptions, ResolvedOptions } from './types.js'

/** A mode is "known" iff it's in the framework registry (the single source of truth for modes). */
export const isKnownMode = (mode: string): boolean => {
  // Own keys only: `in` also accepts inherited names (`constructor`, `toString`), which then crash the factory.
  return Object.hasOwn(frameworks, mode)
}

/**
 * Normalize user options to a fully-resolved shape (defaults: react, boundaries 'error', every layer on).
 *
 * @example
 * resolveOptions({ boundaries: false }) // boundaries layer dropped, everything else default
 */
export const resolveOptions = (userOptions: ConfigOptions = {}): ResolvedOptions => {
  const {
    mode,
    ignores,
    boundaries,
    jsdoc,
    markdown,
    components,
    shadcn,
    fileNaming,
    architecture,
    restrictedSyntax,
    rules,
    userConfigs,
  } = userOptions

  return {
    mode: mode ?? 'react',
    ignores: ignores ?? [],
    boundaries: boundaries === undefined ? 'error' : boundaries === true ? 'error' : boundaries,
    jsdoc: jsdoc ?? true,
    markdown: markdown ?? true,
    components: components ?? true,
    shadcn: shadcn ?? true,
    fileNaming: fileNaming ?? true,
    architecture: architecture ?? true,
    restrictedSyntax: restrictedSyntax ?? [],
    rules: rules ?? {},
    userConfigs: userConfigs ?? [],
  }
}
