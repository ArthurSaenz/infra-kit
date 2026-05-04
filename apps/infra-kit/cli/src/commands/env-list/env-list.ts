import { z } from 'zod/v4'

import { getDopplerProject } from 'src/integrations/doppler/doppler-project'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import type { ToolsExecutionResult } from 'src/types'

/**
 * List available Doppler configs for the detected project.
 *
 * Purely local: reads infra-kit.yml and does not call Doppler. We intentionally
 * do not run validateDopplerCliAndAuth here — users listing envs often do so
 * before `doppler login`, and a spurious auth error would be misleading.
 */
export const envList = async (): Promise<ToolsExecutionResult> => {
  const project = await getDopplerProject()
  const { environments } = await getInfraKitConfig()

  logger.info(`Doppler project: ${project}\n`)
  logger.info('Available configs:')

  for (const env of environments) {
    logger.info(`  - ${env}`)
  }

  const structuredContent = {
    project,
    configs: environments,
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  }
}

// MCP Tool Registration
export const envListMcpTool = {
  name: 'env-list',
  description:
    'List the environments the project is configured to support. Returns the `environments` list declared in infra-kit.yml at the project root (not a live fetch from Doppler) plus the Doppler project name resolved from the same file. Read-only.',
  inputSchema: {},
  outputSchema: {
    project: z.string().describe('Detected Doppler project name'),
    configs: z.array(z.string()).describe('Available environment configs'),
  },
  handler: envList,
}
