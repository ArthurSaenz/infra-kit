// Fixture for the fix pass. Three restating line comments below are meant to go; the workaround
// note is meant to survive verbatim.

import { realpathSync } from 'node:fs'

export async function confirmOrExit(_message: string): Promise<void> {}

export function listServices(): string[] {
  return ['api', 'ui']
}

export function isInsideRoot(root: string, candidate: string): boolean {
  // macOS resolves /var to /private/var, so a realpath'd candidate never matches an unresolved
  // root and containment silently fails. Both sides are resolved before comparing.
  return realpathSync(candidate).startsWith(realpathSync(root))
}

export async function deploySelected(environment: string) {
  const services = listServices()

  // Ask for confirmation
  await confirmOrExit(`deploy ${services.join(', ')} to ${environment}`)

  // Validate all selected services
  const invalidServices = services.filter((service) => service.trim() === '')

  // Log formatted output
  console.log(`${services.length - invalidServices.length} ready`)

  return { services, invalidServices, environment }
}
