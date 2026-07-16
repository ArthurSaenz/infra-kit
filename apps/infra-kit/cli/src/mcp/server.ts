import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { mcpMode } from 'src/lib/mcp-mode'

import { initializePrompts } from './prompts'
import { initializeResources } from './resources'
import { initializeTools } from './tools'

export async function createMcpServer() {
  // Marks `process.stdin` as the JSON-RPC transport for every prompt guard in the
  // process. Set HERE rather than in `entry/mcp.ts` (the sole caller) because that
  // module starts a server at import time and so can never be unit-tested — a test
  // there could only stub the flag, which proves nothing about it ever being set.
  // This runs before `server.connect`, so no tool handler can outrun it.
  mcpMode.enabled = true

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
