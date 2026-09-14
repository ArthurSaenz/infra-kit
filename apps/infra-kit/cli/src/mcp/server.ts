import { McpServer } from '@modelcontextprotocol/server'

import { mcpMode } from 'src/lib/mcp-mode'

import packageJson from '../../package.json' with { type: 'json' }
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
      version: packageJson.version,
    },
    {
      capabilities: {
        // `initializeResources` registers read-only resources below; the SDK's
        // `registerResource` also declares `resources.listChanged` on top of this.
        resources: { listChanged: true },
        tools: {},
        // Deliberately no `prompts`. Every workflow's human surface is its plugin
        // command/skill and its agent surface is the `infra-kit://workflow/*`
        // resource; a prompt registered here rendered a duplicate
        // `/infra-kit:release-create (MCP)` row next to the plugin command (see
        // docs/release-create-prompt-removal-plan.md).
      },
    },
  )

  await initializeResources(server)
  await initializeTools(server)

  return server
}
