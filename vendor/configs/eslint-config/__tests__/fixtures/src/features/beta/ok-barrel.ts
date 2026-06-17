// VALID: imports feature "alpha" through its public barrel.
import { alpha } from '#root/features/alpha'

export const useAlpha = () => alpha
