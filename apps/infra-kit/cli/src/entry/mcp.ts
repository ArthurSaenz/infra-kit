import { serveStdio } from '@modelcontextprotocol/server/stdio'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import { setupErrorHandlers } from 'src/lib/error-handlers'
import { initLoggerMcp } from 'src/lib/logger'
import { suppressTypelessPackageJsonWarning } from 'src/lib/node-warnings'

import { createMcpServer } from '../mcp/server'

// The MCP tools run the same commands as the CLI, so they hit the same consumer `.ts` configs.
// This keeps the client's log pane clean; it cannot affect protocol framing either way, since
// the stdio transport frames JSON-RPC on stdout and `emitWarning` only ever writes to stderr.
suppressTypelessPackageJsonWarning()

const logger = initLoggerMcp()

/**
 * `serveStdio` calls this LAZILY, on the first inbound message, and may call it TWICE on one
 * connection via the probe-then-legacy discard path. The factory must therefore stay free of
 * non-idempotent process-scope side effects.
 */
const buildOrDie = async () => {
  try {
    return await createMcpServer()
  } catch (error) {
    logger.error({ err: error, msg: 'Failed to create MCP server' })
    logger.flush()

    process.exit(1)
  }
}

setupErrorHandlers(logger)

const handle = serveStdio(buildOrDie, {
  onerror: (error) => {
    logger.error({ err: error, msg: 'MCP stdio entry error' })
    logger.flush()
  },
})

// NOT "listening": `serveStdio` returns while the transport start is still pending, so nothing is
// established at this point beyond the entry having been wired up. Claiming readiness here would
// print "listening" on a transport that failed to start.
logger.info({ msg: 'MCP stdio entry started.' })

let isShuttingDown = false

const shutdown = async (signal: NodeJS.Signals) => {
  // A second signal inside the 1500 ms window must not start a second teardown.
  if (isShuttingDown) {
    return
  }

  isShuttingDown = true

  logger.info({ msg: `Received ${signal}. Shutting down...` })

  // Exit 0 is unconditional: a rejecting close() must not escape to `unhandledRejection` and turn a
  // clean shutdown into exit 1. The SDK already routes close errors to `onerror`; this is the belt.
  try {
    await Promise.race([handle.close(), delay(1500)])
  } catch (error) {
    logger.error({ err: error, msg: 'MCP stdio close failed during shutdown' })
  }

  logger.flush()

  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})

process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
