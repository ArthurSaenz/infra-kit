// VIOLATION (new policy): runtime cross-service import — even through the barrel — is not
// allowed. Siblings may reference each other only via `import type`.
import { client } from '../email'

export const sender = client
