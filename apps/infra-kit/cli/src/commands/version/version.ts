import { z } from 'zod/v4'

import { logger } from 'src/lib/logger'
import type { ToolsExecutionResult } from 'src/types'

import packageJson from '../../../package.json' with { type: 'json' }

/**
 * Print the infra-kit CLI version
 */
export const version = async (): Promise<ToolsExecutionResult> => {
  const cliVersion = packageJson.version

  logger.info(cliVersion)

  const structuredContent = { version: cliVersion }

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
export const versionMcpTool = {
  name: 'version',
  description: 'Print the installed infra-kit CLI version',
  inputSchema: {},
  outputSchema: {
    version: z.string().describe('Installed infra-kit CLI version (from package.json)'),
  },
  handler: version,
}
