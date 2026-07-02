import type { TypedFlatConfigItem } from '@antfu/eslint-config'

import { GLOB_BUILTIN_IGNORES } from '../globs.js'

// Built-in ignores first, then consumer globs.
export const ignores = (userIgnores: string[] = []): TypedFlatConfigItem => ({
  ignores: [...GLOB_BUILTIN_IGNORES, ...userIgnores],
})
