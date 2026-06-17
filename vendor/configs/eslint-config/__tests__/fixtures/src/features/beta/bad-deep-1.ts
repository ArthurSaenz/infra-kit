// VIOLATION: reaches into feature "alpha" internals (depth 1), bypassing the barrel.
import { util } from '#root/features/alpha/util'

export const fromAlphaDeep = util
