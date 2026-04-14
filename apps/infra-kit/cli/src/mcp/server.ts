import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { initializePrompts } from './prompts'
import { initializeResources } from './resources'
import { initializeTools } from './tools'

export async function createMcpServer() {
  const server = new McpServer(
    {
      name: 'infra-kit',
      version: '1.0.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
    },
  )

  await initializePrompts(server)
  await initializeResources(server)
  await initializeTools(server)

  return server
}
