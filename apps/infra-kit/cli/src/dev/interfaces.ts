export type LogAttributes = Record<string, unknown>

type LogMethod = (input: string | LogAttributes, ...extras: unknown[]) => void

/**
 * Logger handed to local dev handlers as their third `(event, ctx, log)` argument. Its methods have the
 * same names and signatures as the matching AWS Powertools `Logger` methods, so handler code calling
 * them runs unchanged.
 */
export interface ILogger {
  debug: LogMethod
  info: LogMethod
  warn: LogMethod
  error: LogMethod
  critical: LogMethod
  appendKeys: (attributes: LogAttributes) => void
  removeKeys: (keys: string[]) => void
  createChild: (options?: { serviceName?: string }) => ILogger
}
