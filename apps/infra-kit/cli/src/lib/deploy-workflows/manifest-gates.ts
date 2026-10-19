import type { DeployConfig } from '@slip-stream-kit/config/internal'

/**
 * `<service> -> [envs]` for every service the manifest gates, in the shape the workflow-gates reader
 * returns: a service it leaves out deploys everywhere. `skipEnvs` resolves against the offered
 * environments, so a service skipping only `prod` (never offered) comes out ungated.
 *
 * @example
 * manifestGates({ environments: ['dev', 'stage'], services: { mobile: { envs: ['dev', 'prod'] }, docs: { skipEnvs: ['stage'] } } })
 * // => Map { 'mobile' => ['dev', 'prod'], 'docs' => ['dev'] }
 */
export const manifestGates = (config: DeployConfig): Map<string, string[]> => {
  const gates = new Map<string, string[]>()

  for (const [name, service] of Object.entries(config.services)) {
    if (service.envs !== undefined) {
      gates.set(name, [...service.envs])
      continue
    }

    const skipped = service.skipEnvs ?? []
    const allowed = config.environments.filter((env) => {
      return !skipped.includes(env)
    })

    if (allowed.length < config.environments.length) gates.set(name, allowed)
  }

  return gates
}
