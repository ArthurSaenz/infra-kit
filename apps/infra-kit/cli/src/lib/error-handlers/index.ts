import process from 'node:process'
import type { Logger } from 'pino'

import { LOG_FILE_PATH } from '../logger/index'

/**
 * Setup handlers for fatal, non-signal process events.
 *
 * @param logger - The logger instance
 *
 * ONLY FOR SERVER!
 *
 * Signal handling deliberately does NOT live here: a bounded teardown needs the
 * `StdioServerHandle` returned by `serveStdio`, which only the MCP entry holds, so
 * `SIGINT`/`SIGTERM` are registered in `src/entry/mcp.ts` instead. The arms removed from
 * here called `process.exit(0)` without flushing the logger, discarding the final log
 * lines on every clean shutdown; the entry's `shutdown` flushes before exiting.
 */
export const setupErrorHandlers = (logger: Logger) => {
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error, msg: 'Uncaught Exception' })
    logger.error(`Uncaught Exception! Check ${LOG_FILE_PATH}. Shutting down...`)
    logger.flush()
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, promise) => {
    logger.fatal({ reason, promise, msg: 'Unhandled Rejection' })
    logger.error(`Unhandled Rejection! Check ${LOG_FILE_PATH}. Shutting down...`)
    logger.flush()
    process.exit(1)
  })
}
