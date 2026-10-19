import type { DeployScript } from '@slip-stream-kit/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { agentMode, isAgentMode } from 'src/lib/agent-mode'
import { DEPLOY_VIA_LOCAL_DEPLOY, DeploySkipped, createDeployToolkit } from 'src/lib/deploy-toolkit'
import type { ToolkitDeps } from 'src/lib/deploy-toolkit'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { textContent } from 'src/types'

const SCRIPTS_DIR = 'devops/scripts'

interface DeployRunOptions {
  service: string
  /** Repo root. Defaults to the git toplevel. */
  cwd?: string
  env?: Record<string, string | undefined>
  deps?: ToolkitDeps
}

const result = (structuredContent: { status: 'deployed' | 'skipped'; service: string; reason?: string }) => {
  return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
}

const loadScript = async (scriptPath: string): Promise<DeployScript> => {
  try {
    await fs.access(scriptPath)
  } catch {
    throw new OperationError(undefined, {
      operation: `run ${path.basename(scriptPath)}`,
      remediation: `create ${path.join(SCRIPTS_DIR, path.basename(scriptPath))}, or deploy this service with its .sh script`,
      stderrExcerpt: `${scriptPath} does not exist`,
    })
  }

  const imported = (await import(pathToFileURL(scriptPath).href)) as { default?: unknown }

  if (typeof imported.default !== 'function') {
    throw new OperationError(undefined, {
      operation: `run ${path.basename(scriptPath)}`,
      remediation: 'export the deploy as `export default (async (toolkit) => { … }) satisfies DeployScript`',
      stderrExcerpt: 'the script has no default-exported function',
    })
  }

  return imported.default as DeployScript
}

/**
 * Run the repo's `devops/scripts/deploy-<service>.ts` with the deploy toolkit: what the deploy job
 * runs for a service that has moved off its `.sh` script.
 *
 * Deploys with whatever AWS credentials the environment holds, so an agent may not call it directly;
 * agents deploy through `release deploy-*` or `local deploy-*`.
 *
 * @example
 * await deployRun({ service: 'client-be' }) // runs devops/scripts/deploy-client-be.ts
 */
export const deployRun = async (options: DeployRunOptions) => {
  const { service, env = process.env } = options

  if (!/^[a-z0-9-]+$/.test(service)) {
    throw new OperationError(undefined, {
      operation: 'deploy-run',
      remediation: 'pass the service as in devops/scripts/deploy-<service>.ts, e.g. client-be',
      stderrExcerpt: `invalid service name '${service}'`,
    })
  }

  if (isAgentMode() && env.INFRA_KIT_DEPLOY_VIA !== DEPLOY_VIA_LOCAL_DEPLOY) {
    throw new StructuredRefusalError({ status: 'refused', agentMode: agentMode.source }, 2, {
      operation: `deploy ${service}`,
      remediation:
        'ask a human to run `infra-kit deploy-run` from their own shell, or deploy through `infra-kit release deploy-selected` (CI) or `infra-kit local deploy-selected`, which check the environment first',
      stderrExcerpt: 'deploy-run deploys with whatever AWS credentials are loaded: refused in agent mode',
    })
  }

  const root = options.cwd ?? (await getProjectRoot())
  const script = await loadScript(path.join(root, SCRIPTS_DIR, `deploy-${service}.ts`))

  try {
    await script(createDeployToolkit({ root, service, env, deps: options.deps }))
  } catch (error) {
    if (!(error instanceof DeploySkipped)) throw error

    logger.info(`⏭️  ${service} skipped: ${error.message}`)

    return result({ status: 'skipped', service, reason: error.message })
  }

  logger.info(`✅ ${service} deployed`)

  return result({ status: 'deployed', service })
}
