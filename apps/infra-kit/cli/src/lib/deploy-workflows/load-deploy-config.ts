import { DEPLOY_CONFIG_FILE, deployConfigSchema } from '@slip-stream-kit/config/internal'
import type { DeployConfig } from '@slip-stream-kit/config/internal'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

import { DEFAULT_PROTECTED_ENVS } from 'src/lib/workflow-envs/protected-envs'

/**
 * The repo's parsed `infra-kit.deploy.ts`, or `undefined` when the repo has none.
 *
 * Loaded with Node's native type stripping, so a manifest's `import type` from
 * `@slip-stream-kit/config` is erased and never resolved: a repo still on a release that predates
 * the deploy types loads fine. The schema is this CLI's own copy, so validation does not depend on
 * what the repo has installed either.
 *
 * @throws When the file exists but has no default export, fails the schema, gates a service on an
 * environment it does not know, or would replace v1 without the environments delivery dispatches.
 */
export const loadDeployConfig = async (projectRoot: string): Promise<DeployConfig | undefined> => {
  const configPath = path.join(projectRoot, DEPLOY_CONFIG_FILE)

  try {
    await fs.access(configPath)
  } catch {
    return undefined
  }

  const imported = (await import(pathToFileURL(configPath).href)) as { default?: unknown }

  if (imported.default === undefined) {
    throw new Error(`${DEPLOY_CONFIG_FILE} at ${configPath} has no default export`)
  }

  const parsed = deployConfigSchema.safeParse(imported.default)

  if (!parsed.success) {
    throw new Error(`Invalid ${DEPLOY_CONFIG_FILE} at ${configPath}:\n${z.prettifyError(parsed.error)}`)
  }

  const problems = [...unknownGateEnvs(parsed.data), ...undeliverableReplacement(parsed.data)]

  if (problems.length > 0) {
    throw new Error(`Invalid ${DEPLOY_CONFIG_FILE} at ${configPath}:\n${problems.join('\n')}`)
  }

  return parsed.data
}

/**
 * Delivery dispatches `deploy-all.yml -f environment=prod`, which GitHub refuses unless the choice input
 * offers it, so a manifest taking over that file must offer every protected environment.
 */
const undeliverableReplacement = (config: DeployConfig): string[] => {
  if (config.replaceV1 !== true) return []

  return DEFAULT_PROTECTED_ENVS.filter((env) => {
    return !config.environments.includes(env)
  }).map((env) => {
    return `✖ replaceV1: environments must include '${env}', which delivery dispatches deploy-all.yml with`
  })
}

/**
 * `envs` / `skipEnvs` names that are neither offered nor protected: a typo such as `stagee` would
 * otherwise gate nothing, silently. Protected environments (prod) are not in the dispatch menu, since
 * they are delivered rather than deployed, yet a service may still be gated on them.
 */
const unknownGateEnvs = (config: DeployConfig): string[] => {
  const known = new Set([...config.environments, ...DEFAULT_PROTECTED_ENVS])

  return Object.entries(config.services).flatMap(([name, service]) => {
    return (['envs', 'skipEnvs'] as const).flatMap((key) => {
      return (service[key] ?? [])
        .filter((env) => {
          return !known.has(env)
        })
        .map((env) => {
          return `✖ services.${name}.${key}: unknown environment '${env}' (known: ${[...known].join(', ')})`
        })
    })
  })
}
