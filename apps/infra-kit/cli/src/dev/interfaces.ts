import type { LogLevel, LoggerInterface } from '@aws-lambda-powertools/logger/types'

/**
 * Logger handed to local dev handlers as their third `(event, ctx, log)` argument.
 * Extends AWS Powertools `LoggerInterface` so the real Powertools `Logger` (or any
 * compatible implementation) is assignable wherever a handler expects it.
 */
export interface ILogger extends LoggerInterface {}

// Re-export for consumers that need the Powertools LogLevel type.
export type { LogLevel }
