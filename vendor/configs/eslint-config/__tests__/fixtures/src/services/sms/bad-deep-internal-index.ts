// VIOLATION: reaches into a NESTED `internal/index.js` of service "email". The barrel carve-out
// exempts only the immediate `services/email/index`, so a nested index is still flagged.
import { internalClient } from '#root/services/email/internal/index.js'

export const fromEmailInternalIndex = internalClient
