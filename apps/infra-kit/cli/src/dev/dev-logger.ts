/*
 * Writes through the GLOBAL console on purpose: `output-intercept.ts` owns those methods and routes each
 * line to the right per-service log file. A private Console or a direct stream write would bypass it.
 */
/* eslint-disable no-console */
import type { ILogger, LogAttributes } from './interfaces.js'

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'

const CONSOLE_METHOD = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  CRITICAL: 'error',
} as const satisfies Record<Level, keyof Console>

const serializeError = (error: Error): LogAttributes => {
  return { name: error.name, message: error.message, stack: error.stack }
}

// Same merge rules as Powertools, so handler code written against it logs the same shape locally.
const mergeExtras = (extras: unknown[]): LogAttributes => {
  const merged: LogAttributes = {}
  const rest: unknown[] = []

  for (const extra of extras) {
    if (extra instanceof Error) {
      merged.error = serializeError(extra)
    } else if (extra !== null && typeof extra === 'object') {
      Object.assign(merged, extra)
    } else {
      rest.push(extra)
    }
  }

  if (rest.length > 0) merged.extra = rest

  return merged
}

/**
 * The logger a local dev handler gets as its third `(event, ctx, log)` argument. It prints one JSON object
 * per line in the Powertools shape (`level`, `message`, `service`, `timestamp`, then the attributes).
 */
export const createDevLogger = (serviceName: string, keys: LogAttributes = {}): ILogger => {
  const attributes: LogAttributes = { ...keys }

  const emit = (level: Level) => {
    return (input: string | LogAttributes, ...extras: unknown[]): void => {
      const message = typeof input === 'string' ? { message: input } : input

      const entry = {
        level,
        ...message,
        service: serviceName,
        timestamp: new Date().toISOString(),
        ...attributes,
        ...mergeExtras(extras),
      }

      console[CONSOLE_METHOD[level]](JSON.stringify(entry))
    }
  }

  return {
    debug: emit('DEBUG'),
    info: emit('INFO'),
    warn: emit('WARN'),
    error: emit('ERROR'),
    critical: emit('CRITICAL'),
    appendKeys: (extra) => {
      Object.assign(attributes, extra)
    },
    removeKeys: (names) => {
      for (const name of names) {
        Reflect.deleteProperty(attributes, name)
      }
    },
    createChild: (options = {}) => {
      return createDevLogger(options.serviceName ?? serviceName, attributes)
    },
  }
}
