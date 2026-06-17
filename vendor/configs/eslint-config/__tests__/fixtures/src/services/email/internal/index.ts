// Nested internal barrel of service "email". Importing this from outside is STILL a violation:
// only the IMMEDIATE service barrel is exempt, not a nested `internal/index`.
export const internalClient = 'internal-client'
