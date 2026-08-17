import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import process from 'node:process'

import { setupErrorHandlers } from 'src/lib/error-handlers'
import { initLoggerMcp } from 'src/lib/logger'
import { suppressTypelessPackageJsonWarning } from 'src/lib/node-warnings'

import { createMcpServer } from '../mcp/server'

// The MCP tools run the same commands as the CLI, so they hit the same consumer `.ts` configs.
// This keeps the client's log pane clean; it cannot affect protocol framing either way, since
// the stdio transport frames JSON-RPC on stdout and `emitWarning` only ever writes to stderr.
suppressTypelessPackageJsonWarning()

const logger = initLoggerMcp()

const startServer = async () => {
  let server

  try {
    server = await createMcpServer()

    logger.info('MCP Server instance created')
  } catch (error) {
    logger.error({ err: error, msg: 'Failed to create MCP server' })
    logger.error(`Fatal error during server creation.`)

    process.exit(1)
  }

  try {
    const transport = new StdioServerTransport()

    await server.connect(transport)

    logger.info({ msg: 'Server connected to transport. Ready.' })
  } catch (error) {
    logger.error({ err: error, msg: 'Failed to initialize server' })
    logger.error(`Fatal error during server transport init.`)

    process.exit(1)
  }
}

// Setup error handlers
setupErrorHandlers(logger)

// Start the server
startServer()
