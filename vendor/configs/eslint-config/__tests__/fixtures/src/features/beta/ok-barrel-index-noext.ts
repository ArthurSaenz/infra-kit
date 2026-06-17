// VALID: imports feature "alpha" through its EXPLICIT barrel without extension (#root/features/alpha/index).
import { alpha } from '#root/features/alpha/index'

export const useAlphaIndexNoExt = () => alpha
