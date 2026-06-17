// VIOLATION: the shared layer must not depend outward on a feature (not even its barrel).
import { thing } from '../features/alpha'

export const leaked = thing
