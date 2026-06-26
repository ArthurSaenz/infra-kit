import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getExposedMcpTools } from 'src/lib/command-catalog'
import { createToolHandler } from 'src/lib/tool-handler'

export const initializeTools = async (server: McpServer) => {
  // The registered tool set is derived from the single command catalog, filtered
  // by its explicit `mcpExposed` allowlist. doctor / vendor-sync / vendor-manifest
  // are intentionally excluded there and must never be registered here.
  for (const tool of getExposedMcpTools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      },
      createToolHandler({ toolName: tool.name, handler: tool.handler }),
    )
  }
}
