// VALID: same-feature relative import into own internals.
import { util } from './local/util'

export const own = util
