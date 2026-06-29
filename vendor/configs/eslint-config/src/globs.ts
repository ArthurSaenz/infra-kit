// Shared glob constants. New config modules should reference these instead of re-typing the globs.

/** Every lintable source extension — the scope of the boundaries layer. */
export const GLOB_SRC_ALL = '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'

/** TypeScript sources (incl. TSX) — the scope of the size-gated JSDoc layer. */
export const GLOB_TS = '**/*.{ts,tsx}'

/** Markdown files. */
export const GLOB_MD = '**/*.md'

/** Svelte single-file components. */
export const GLOB_SVELTE = '**/*.svelte'

/** Files exempt from the JSDoc layer (tests, stories, declarations). */
export const GLOB_TS_DOC_EXCLUDE = [
  '**/*.test.{ts,tsx}',
  '**/*.spec.{ts,tsx}',
  '**/*.stories.{ts,tsx}',
  '**/__tests__/**',
  '**/*.d.ts',
]

/** Always-ignored paths (generated/large/operational files). User ignores are appended after these. */
export const GLOB_BUILTIN_IGNORES = [
  '**/routeTree.gen.ts',
  '**/citiesOld.json',
  '**/airports.json',
  '**/.astro/',
  '**/.omc/**',
]
