import process from 'node:process'
import pino from 'pino'
import pretty from 'pino-pretty'

// eslint-disable-next-line sonarjs/publicly-writable-directories
export const LOG_FILE_PATH = '/tmp/mcp-infra-kit.log'

export const initLoggerMcp = () => {
  const logLevel = process.argv.includes('--debug') ? 'debug' : 'info'

  const logger = pino({ level: logLevel }, pino.destination({ dest: LOG_FILE_PATH }))

  logger.info(`Logger initialized with level: ${logLevel}. Logging to: ${LOG_FILE_PATH}`)

  return logger
}

export const initLoggerCLI = () => {
  const logLevel = process.argv.includes('--debug') ? 'debug' : 'info'

  const ignoreFields = ['time', 'pid', 'hostname']

  if (logLevel === 'debug') {
    ignoreFields.push('level')
  }

  const logger = pino(
    { level: logLevel },
    pretty({
      destination: 2,
      ignore: ignoreFields.join(','),
      colorize: true,
    }),
  )

  return logger
}

// Singleton logger instance for CLI usage
export const logger = initLoggerCLI()
