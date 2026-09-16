import process from 'node:process'
import pino from 'pino'
import pretty from 'pino-pretty'

/**
 * Key paths pino censors before anything reaches a destination. The load-bearing case is a handler
 * that logs its `params` object: a token-carrying key in that object would land on stderr verbatim,
 * and stderr is captured by CI logs and terminal scrollback alike.
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
