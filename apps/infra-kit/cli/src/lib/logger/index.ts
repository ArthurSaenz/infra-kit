import process from 'node:process'
import pino from 'pino'
import pretty from 'pino-pretty'

// eslint-disable-next-line sonarjs/publicly-writable-directories
export const LOG_FILE_PATH = '/tmp/mcp-infra-kit.log'

/**
 * Key paths pino censors before anything reaches a destination. The load-bearing case is the MCP
 * tool-handler, which logs every tool's `params` object — twice (at entry, and again in its catch) —
 * into a WORLD-READABLE `/tmp/mcp-infra-kit.log`. A token-carrying key in that object would be
 * written to a file every user on the box can read.
 *
 * The wildcard forms cover the nesting we actually produce: `{ params: { … } }` and `{ err: { … } }`
 * are both one level deep, so `*.token` catches `params.token` without enumerating every wrapper.
 *
 * LIMIT — read this before trusting it: pino's `redact` is KEY-PATH based. It cannot see a token that
 * was INTERPOLATED into a message string (`logger.info(\`token ${t}\`)`) — that string is opaque to
 * it and would be written verbatim. So this is a backstop, not the rule. The RULE is that a token
 * never enters a message string; everything user-facing renders it through `redactToken` first.
 */
const REDACT_PATHS = [
  'token',
  '*.token',
  'serviceToken',
  '*.serviceToken',
  'DOPPLER_TOKEN',
  '*.DOPPLER_TOKEN',
  'INFRA_KIT_ENV_TOKEN',
  '*.INFRA_KIT_ENV_TOKEN',
]

export const initLoggerMcp = () => {
  const logLevel = process.argv.includes('--debug') ? 'debug' : 'info'

  const logger = pino({ level: logLevel, redact: REDACT_PATHS }, pino.destination({ dest: LOG_FILE_PATH }))

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
    { level: logLevel, redact: REDACT_PATHS },
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
