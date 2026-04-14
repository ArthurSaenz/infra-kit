import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { envClearMcpTool } from 'src/commands/env-clear'
import { envListMcpTool } from 'src/commands/env-list'
import { envLoadMcpTool } from 'src/commands/env-load'
import { envStatusMcpTool } from 'src/commands/env-status'
import { ghMergeDevMcpTool } from 'src/commands/gh-merge-dev'
import { ghReleaseDeliverMcpTool } from 'src/commands/gh-release-deliver'
import { ghReleaseDeployAllMcpTool } from 'src/commands/gh-release-deploy-all'
import { ghReleaseDeploySelectedMcpTool } from 'src/commands/gh-release-deploy-selected'
import { ghReleaseListMcpTool } from 'src/commands/gh-release-list'
import { releaseCreateMcpTool } from 'src/commands/release-create'
import { releaseCreateBatchMcpTool } from 'src/commands/release-create-batch'
import { worktreesAddMcpTool } from 'src/commands/worktrees-add'
import { worktreesListMcpTool } from 'src/commands/worktrees-list'
import { worktreesRemoveMcpTool } from 'src/commands/worktrees-remove'
import { worktreesSyncMcpTool } from 'src/commands/worktrees-sync'
import { createToolHandler } from 'src/lib/tool-handler'

const tools = [
  envStatusMcpTool,
  envListMcpTool,
  envLoadMcpTool,
  envClearMcpTool,
  ghMergeDevMcpTool,
  releaseCreateMcpTool,
  releaseCreateBatchMcpTool,
  ghReleaseDeliverMcpTool,
  ghReleaseDeployAllMcpTool,
  ghReleaseDeploySelectedMcpTool,
  ghReleaseListMcpTool,
  worktreesAddMcpTool,
  worktreesListMcpTool,
  worktreesRemoveMcpTool,
  worktreesSyncMcpTool,
]

export const initializeTools = async (server: McpServer) => {
  for (const tool of tools) {
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
