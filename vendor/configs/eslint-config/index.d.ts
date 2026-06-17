export interface ConfigOptions {
  /** Framework preset. Defaults to 'react'. */
  mode?: 'react' | 'svelte'
  /** Extra ignore globs appended to the built-in ignores. */
  ignores?: string[]
}

/**
 * Build the shared flat ESLint config (wraps @antfu/eslint-config + sonarjs +
 * architecture import boundaries). Returns a flat-config array.
 */
declare const config: (userOptions?: ConfigOptions) => Promise<any[]>

export default config
