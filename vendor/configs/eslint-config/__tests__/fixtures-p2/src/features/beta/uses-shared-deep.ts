// VIOLATION: shared is runtime-importable only through its barrel, not its internals.
import { sharedUtil } from '../../shared/util'

export const fromSharedDeep = sharedUtil
