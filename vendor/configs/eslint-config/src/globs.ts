/** Every lintable source extension (boundaries layer scope). */
export const GLOB_SRC_ALL = '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'

/** TS sources (JSDoc layer scope). */
export const GLOB_TS = '**/*.{ts,tsx}'

export const GLOB_MD = '**/*.md'

export const GLOB_SVELTE = '**/*.svelte'

/** Files exempt from the JSDoc layer (tests, stories, declarations). */
export const GLOB_TS_DOC_EXCLUDE = [
  '**/*.test.{ts,tsx}',
  '**/*.spec.{ts,tsx}',
  '**/*.stories.{ts,tsx}',
  '**/__tests__/**',
  '**/*.d.ts',
]

/** Always-ignored paths; user ignores are appended after these. */
export const GLOB_BUILTIN_IGNORES = [
  '**/routeTree.gen.ts',
  '**/citiesOld.json',
  '**/airports.json',
  '**/.astro/',
  '**/.omc/**',
]
