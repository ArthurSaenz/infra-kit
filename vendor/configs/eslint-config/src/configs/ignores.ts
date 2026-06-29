import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import { GLOB_BUILTIN_IGNORES } from '../globs.js'

// Final ignores block: built-in ignores first, then consumer globs (both are additive).
export const ignores = (userIgnores: string[] = []): TypedFlatConfigItem => ({
  ignores: [...GLOB_BUILTIN_IGNORES, ...userIgnores],
})
