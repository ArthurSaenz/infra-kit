// VALID: features may import the shared layer at runtime, through its barrel.
import { sharedUtil } from '../../shared'

export const fromShared = sharedUtil
