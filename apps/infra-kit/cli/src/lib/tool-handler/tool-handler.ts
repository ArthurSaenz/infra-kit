import { logger } from 'src/lib/logger'
import type { ToolsExecutionResult } from 'src/types'

interface ToolHandlerArgs {
  toolName: string
  handler: (params: any) => Promise<ToolsExecutionResult>
}

export const createToolHandler = (args: ToolHandlerArgs) => {
  return async (params: unknown) => {
    const { toolName, handler } = args

    logger.info({ msg: `Tool execution started: ${toolName}`, params })
    try {
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
