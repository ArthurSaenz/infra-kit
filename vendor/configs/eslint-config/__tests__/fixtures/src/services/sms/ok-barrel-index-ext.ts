// VALID: imports service "email" through its EXPLICIT barrel with extension (#root/services/email/index.js).
import { email } from '#root/services/email/index.js'

export const useEmailIndexExt = () => email
