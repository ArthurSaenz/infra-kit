// VIOLATION: reaches into service "email" internals, bypassing the barrel.
import { client } from '#root/services/email/client'

export const fromEmailDeep = client
