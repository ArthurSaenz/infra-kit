import { z } from 'zod'

import { validateDopplerCliAndAuth } from 'src/integrations/doppler'
import { getDopplerProject } from 'src/integrations/doppler/doppler-project'
import { ENVs } from 'src/lib/constants'
import { logger } from 'src/lib/logger'
import type { ToolsExecutionResult } from 'src/types'

/**
 * List available Doppler configs for the detected project
 */
export const envList = async (): Promise<ToolsExecutionResult> => {
  await validateDopplerCliAndAuth()

  const project = await getDopplerProject()

  logger.info(`Doppler project: ${project}\n`)
  logger.info('Available configs:')

  for (const env of ENVs) {
    logger.info(`  - ${env}`)
  }

  const structuredContent = {
    project,
    configs: ENVs,
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
    'List the environments the project is configured to support. Returns a static list defined in infra-kit constants (not a live fetch from Doppler) plus the Doppler project name auto-detected from the current directory. Read-only.',
  inputSchema: {},
  outputSchema: {
    project: z.string().describe('Detected Doppler project name'),
    configs: z.array(z.string()).describe('Available environment configs'),
  },
  handler: envList,
}
