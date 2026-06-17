// VIOLATION: feature beta reaches into feature alpha's internals, bypassing its barrel.
import { thing } from '../alpha/internal/thing'

export const fromAlphaInternal = thing
