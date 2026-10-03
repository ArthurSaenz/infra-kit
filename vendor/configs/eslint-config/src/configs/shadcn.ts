import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import { plugin as shadcn } from '@shadcn/lint'

import { GLOB_SRC_ALL, GLOB_SVELTE } from '../globs.js'
import type { ConfigRules } from '../types.js'

// Tailwind design-system rules (https://github.com/shadcn-ui/lint#get-started). No languageOptions:
// antfu already configures the TS/JSX and Svelte parsers for these files.
export const shadcnConfig: TypedFlatConfigItem = {
  name: 'wl/shadcn',
  files: [GLOB_SRC_ALL, GLOB_SVELTE],
  plugins: { shadcn },
  rules: {
    'shadcn/no-arbitrary-values': 'error',
  } as ConfigRules,
}
