import type { DeployScript } from '@slip-stream-kit/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { agentMode, isAgentMode } from 'src/lib/agent-mode'
import { DEPLOY_VIA_LOCAL_DEPLOY, DeploySkipped, createDeployToolkit, defaultToolkitDeps } from 'src/lib/deploy-toolkit'
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

/** The `.sh` a service without a `deploy` in infra-kit.deploy.ts runs, as the v1 jobs do. */
const legacyScriptFor = async (root: string, service: string): Promise<string> => {
  const script = path.join(root, 'devops', 'scripts', `deploy-${service}.sh`)

  try {
    await fs.access(script)
  } catch {
    throw new OperationError(undefined, {
      operation: `deploy ${service}`,
      remediation: `set services['${service}'].deploy in infra-kit.deploy.ts, e.g. 'apps/<app>/deploy.ts'`,
      stderrExcerpt: `${service} has no deploy in infra-kit.deploy.ts and no devops/scripts/deploy-${service}.sh`,
    })
  }

  return script
}

/** Encoded as @actions/core's setSecret does: the runner decodes these before registering the mask. */
const maskCommand = (value: string) => {
  return `::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`
}

/**
 * The shared job's `extra-env` secret, `KEY=VALUE` lines (e.g. MONITORING_IP), as environment.
 * Each value is masked in the job log first: the runner masks a multi-line secret line by line, i.e.
 * `KEY=value` whole, never the bare value a script may print.
 */
const extraEnv = (lines: string | undefined, log: (line: string) => void): Record<string, string> => {
  const entries = (lines ?? '')
    .split('\n')
    .filter((line) => {
      return line.trim() !== ''
    })
    .map((line) => {
      const separator = line.indexOf('=')
      const key = line.slice(0, Math.max(separator, 0))

      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        throw new OperationError(undefined, {
          operation: 'deploy-run',
          remediation: 'write each extra-env line as KEY=VALUE with an upper-case KEY',
          stderrExcerpt: 'an extra-env line is not KEY=VALUE',
        })
      }

      return [key, line.slice(separator + 1)] as const
    })

  for (const [, value] of entries) {
    if (value !== '') log(maskCommand(value))
  }

  return Object.fromEntries(entries)
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
 * Deploy one service: its TypeScript deploy (`deploy` in infra-kit.deploy.ts) with the deploy toolkit,
 * else its `devops/scripts/deploy-<service>.sh`. The whole of the shared deploy job's deploy step;
 * `INFRA_KIT_EXTRA_ENV` carries the job's `extra-env` secret.
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
  const deps = options.deps ?? defaultToolkitDeps
  const { INFRA_KIT_EXTRA_ENV, ...inherited } = env
  const scriptEnv = { ...inherited, ...extraEnv(INFRA_KIT_EXTRA_ENV, deps.log) }
  const scriptPath = (await loadDeployConfig(root))?.services[service]?.deploy

  if (scriptPath === undefined) {
    // `sh`, not `bash`: the v1 jobs run the scripts this way.
    await deps.run('sh', [await legacyScriptFor(root, service)], { cwd: root, env: scriptEnv })
  } else {
    const script = await loadScript(path.join(root, scriptPath))
    const toolkit = createDeployToolkit({ root, service, scriptDir: path.dirname(scriptPath), env: scriptEnv, deps })

    try {
      await script(toolkit)
    } catch (error) {
      if (!(error instanceof DeploySkipped)) throw error

      logger.info(`⏭️  ${service} skipped: ${error.message}`)

      return result({ status: 'skipped', service, reason: error.message })
    }
  }

  logger.info(`✅ ${service} deployed`)

  return result({ status: 'deployed', service })
}
