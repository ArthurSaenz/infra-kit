import process from 'node:process'
import type { Logger } from 'pino'

import { LOG_FILE_PATH } from '../logger/index'

/**
 * Setup error handlers for the application
 * @param logger - The logger instance
 *
 * ONLY FOR SERVER!
 */
export const setupErrorHandlers = (logger: Logger) => {
  process.on('SIGINT', () => {
    logger.info({ msg: 'Received SIGINT. Shutting down...' })
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    logger.info({ msg: 'Received SIGTERM. Shutting down...' })
    process.exit(0)
  })

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
