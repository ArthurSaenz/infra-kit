// VALID: imports service "email" through its public barrel.
import { email } from '#root/services/email'

export const useEmail = () => email
