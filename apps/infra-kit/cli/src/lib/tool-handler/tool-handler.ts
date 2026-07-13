import { ensureUserProjectConfig } from 'src/lib/config-bootstrap'
import { logger } from 'src/lib/logger'
import type { ToolsExecutionResult } from 'src/types'

interface ToolHandlerArgs {
  toolName: string
  handler: (params: any) => Promise<ToolsExecutionResult>
}

export const createToolHandler = ({
  toolName,
  handler,
}: ToolHandlerArgs): ((params: unknown) => Promise<ToolsExecutionResult>) => {
  return async (params: unknown) => {
    logger.info({ msg: `Tool execution started: ${toolName}`, params })
    try {
      // MCP entry-boundary seed. This wrapper is the sole chokepoint for every exposed tool
      // (`src/mcp/tools/index.ts` holds the only `registerTool` call), and the `mcp` command itself is
      // in program.ts's SEED_EXCLUDED — so an MCP server seeds lazily, on its FIRST tool invocation,
      // and a server that never receives one never writes to $HOME. The once-per-process guard inside
      // ensureUserProjectConfig makes calls 2..N free on this long-lived process.
      //
      // Deliberately INSIDE the try, not before it: defense-in-depth. ensureUserProjectConfig is
      // contractually never-throw, but if that contract ever broke, an unhandled rejection here would
      // take down the long-lived server. Inside the try it degrades to an ordinary tool error.
      await ensureUserProjectConfig()

      const payload = await handler({ ...(params as object), confirmedCommand: true })

      logger.info({ msg: `Tool execution successful: ${toolName}` })

      return payload
    } catch (error) {
      logger.error({
        err: error,
        params,
        msg: `Tool execution failed: ${toolName}`,
      })

      throw error
    }
  }
}
