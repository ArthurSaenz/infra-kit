import type { LogLevel, LoggerInterface } from '@aws-lambda-powertools/logger/types'

/**
 * Logger interface for dev/local use. Extends AWS Powertools LoggerInterface
 * so implementations are compatible where that type is expected.
 */
export interface ILogger extends LoggerInterface {}

/** Numeric log levels (lower = more verbose). */
export const LoggerLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
} as const

export type LoggerLevelValue = (typeof LoggerLevel)[keyof typeof LoggerLevel]

/** Map from numeric level to method name for ILogger. */
export const LOG_LEVEL_TO_METHOD: Record<LoggerLevelValue, string> = {
  [LoggerLevel.DEBUG]: 'debug',
  [LoggerLevel.INFO]: 'info',
  [LoggerLevel.WARN]: 'warn',
  [LoggerLevel.ERROR]: 'error',
  [LoggerLevel.FATAL]: 'fatal',
}

export interface ITraceInfo {
  traceId: string
  spanId?: string
  spanParent?: string
  apiName?: string
}

export interface IConfigLogger {
  minLevel?: string
  trace?: ITraceInfo
  printTraceInfo?: boolean
  printExtraData?: boolean
  maxExtraDataLength?: number
  serviceName?: string
}

// Re-export for consumers that need the Powertools LogLevel type
export type { LogLevel }
