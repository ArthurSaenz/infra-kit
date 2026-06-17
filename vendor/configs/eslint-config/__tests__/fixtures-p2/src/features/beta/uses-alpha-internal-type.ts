// VALID: type-only deep import is allowed (types are erased at runtime).
import type { Thing } from '../alpha/internal/thing'

export const makeThing = (id: string): Thing => ({ id })
