// VALID: type-only cross-service import (no runtime coupling).
import type { EmailClient } from '../email'

export const makeClient = (id: string): EmailClient => ({ id })
