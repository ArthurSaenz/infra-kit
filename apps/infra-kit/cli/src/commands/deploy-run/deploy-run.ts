import type { DeployScript } from '@slip-stream-kit/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { agentMode, isAgentMode } from 'src/lib/agent-mode'
import { DEPLOY_VIA_LOCAL_DEPLOY, DeploySkipped, createDeployToolkit } from 'src/lib/deploy-toolkit'
import type { ToolkitDeps } from 'src/lib/deploy-toolkit'
import { loadDeployConfig } from 'src/lib/deploy-workflows'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { textContent } from 'src/types'

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

/** The service's `deploy` path from infra-kit.deploy.ts, relative to the root. */
const scriptFor = async (root: string, service: string): Promise<string> => {
  const config = await loadDeployConfig(root)
  const script = config?.services[service]?.deploy

  if (script === undefined) {
    throw new OperationError(undefined, {
      operation: `deploy ${service}`,
      remediation: `set services['${service}'].deploy in infra-kit.deploy.ts, e.g. 'apps/<app>/deploy.ts'`,
      stderrExcerpt: config === undefined ? 'no infra-kit.deploy.ts in this repo' : `${service} has no deploy script`,
    })
  }

  return script
}

const loadScript = async (scriptPath: string): Promise<DeployScript> => {
  try {
    await fs.access(scriptPath)
  } catch {
    throw new OperationError(undefined, {
      operation: `run ${path.basename(scriptPath)}`,
      remediation: 'create it, or fix the deploy path in infra-kit.deploy.ts',
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
 * Run a service's TypeScript deploy (its `deploy` in infra-kit.deploy.ts) with the deploy toolkit:
 * what the deploy job runs for a service that has moved off its `.sh` script.
 *
 * Deploys with whatever AWS credentials the environment holds, so an agent may not call it directly;
 * agents deploy through `release deploy-*` or `local deploy-*`.
 *
 * @example
 * await deployRun({ service: 'client-be' }) // services['client-be'].deploy: 'apps/client/api/deploy.ts'
 */
export const deployRun = async (options: DeployRunOptions) => {
  const { service, env = process.env } = options

  if (!/^[a-z0-9-]+$/.test(service)) {
    throw new OperationError(undefined, {
      operation: 'deploy-run',
      remediation: 'pass the service as infra-kit.deploy.ts names it, e.g. client-be',
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
  const scriptPath = await scriptFor(root, service)
  const script = await loadScript(path.join(root, scriptPath))
  const toolkit = createDeployToolkit({ root, service, scriptDir: path.dirname(scriptPath), env, deps: options.deps })

  try {
    await script(toolkit)
  } catch (error) {
    if (!(error instanceof DeploySkipped)) throw error

    logger.info(`⏭️  ${service} skipped: ${error.message}`)

    return result({ status: 'skipped', service, reason: error.message })
  }

  logger.info(`✅ ${service} deployed`)

  return result({ status: 'deployed', service })
}
