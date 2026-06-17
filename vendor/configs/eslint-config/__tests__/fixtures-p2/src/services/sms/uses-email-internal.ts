// VIOLATION: service sms reaches into service email's internals, bypassing its barrel.
import { client } from '../email/internal/client'

export const sender = client
