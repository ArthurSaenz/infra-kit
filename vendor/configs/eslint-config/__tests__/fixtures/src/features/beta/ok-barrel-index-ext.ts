// VALID: imports feature "alpha" through its EXPLICIT barrel with extension (#root/features/alpha/index.js).
// This is the only valid barrel form under NodeNext/ESM and must pass.
import { alpha } from '#root/features/alpha/index.js'

export const useAlphaIndexExt = () => alpha
