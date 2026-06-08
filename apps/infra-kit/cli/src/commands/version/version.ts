import { z } from 'zod'

import { logger } from 'src/lib/logger'
import { defineMcpTool, textContent } from 'src/types'

import packageJson from '../../../package.json' with { type: 'json' }

/**
 * Print the infra-kit CLI version
 */
export const version = async () => {
  const cliVersion = packageJson.version

  logger.info(cliVersion)

  const structuredContent = { version: cliVersion }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const versionMcpTool = defineMcpTool({
  name: 'version',
  description: 'Print the installed infra-kit CLI version',
  inputSchema: {},
  outputSchema: {
    version: z.string().describe('Installed infra-kit CLI version (from package.json)'),
  },
  handler: version,
})
