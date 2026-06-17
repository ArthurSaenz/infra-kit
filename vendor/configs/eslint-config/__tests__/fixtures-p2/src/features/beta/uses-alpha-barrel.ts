// VIOLATION (new policy): runtime cross-feature import — even through the barrel — is not
// allowed. Siblings may reference each other only via `import type`.
import { thing } from '../alpha'

export const fromAlpha = thing
