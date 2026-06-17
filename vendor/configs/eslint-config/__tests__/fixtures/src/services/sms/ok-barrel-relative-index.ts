// VALID: imports service "email" barrel via a RELATIVE explicit-index specifier whose string
// still contains the `services/<name>/index.js` segment — the exact reported false-positive shape
// (e.g. backoffice-api recompute.ts importing '../../services/data-ops/index.js').
import { email } from '../../services/email/index.js'

export const useEmailRelativeIndex = () => email
