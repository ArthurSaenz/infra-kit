import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Logger } from 'src/dev/logger'

/**
 * Logger tests favor PUBLIC getters. The two behaviors that only surface on stdout
 * (level filtering + extra-data truncation) use a GUARDED spy, restored in afterEach.
 * We assert with stringContaining / absence — never equality — because the output
 * carries an ISO timestamp, chalk ANSI codes, and (for children) random span ids.
 *
 * The Powertools no-op stubs (addContext, flushBuffer, injectLambdaContext, …) are
 * intentionally NOT tested.
 */
describe('logger — trace context', () => {
  it('createChild inherits the parent traceId but gets a fresh spanId', () => {
    const parent = new Logger({ serviceName: 'Parent', trace: { traceId: 'TRACE_ABC' } })
    const parentSpan = parent.getTraceContext()?.spanId

    const child = parent.createChild({ serviceName: 'Child' })

    // createChild is typed to return ILogger; narrow via instanceof (no cast) to
    // reach the concrete Logger's getTraceContext() getter.
    expect(child).toBeInstanceOf(Logger)
    if (!(child instanceof Logger)) return

    const childTrace = child.getTraceContext()

    expect(childTrace?.traceId).toBe('TRACE_ABC')
    expect(childTrace?.spanId).not.toBe(parentSpan)
    expect(childTrace?.spanParent).toBe(parentSpan)
  })
})

describe('logger — persistent log attributes', () => {
  it('appendPersistentKeys accumulates keys and removeKeys deletes them', () => {
    const log = new Logger({ serviceName: 'X' })

    log.appendPersistentKeys({ a: 1, b: 2 })
    expect(log.getPersistentLogAttributes()).toEqual({ a: 1, b: 2 })

    log.removeKeys(['a'])
    expect(log.getPersistentLogAttributes()).toEqual({ b: 2 })
  })
})

describe('logger — level name mapping', () => {
  it('maps the FATAL level out to the "CRITICAL" name', () => {
    const log = new Logger({ serviceName: 'X', minLevel: 'FATAL' })

    expect(log.getLevelName()).toBe('CRITICAL')
  })

  it('cannot round-trip CRITICAL back in: setLevel("CRITICAL") falls back to INFO', () => {
    // Asymmetry quirk: getLevelName() emits "CRITICAL", but "CRITICAL" is not a
    // configured input level, so setLevel() silently falls back to INFO.
    const log = new Logger({ serviceName: 'X', minLevel: 'FATAL' })

    log.setLevel('CRITICAL')
    expect(log.getLevelName()).toBe('INFO')
  })
})

describe('logger — stdout behavior (guarded spy)', () => {
  const captureStdout = (): { lines: string[] } => {
    const lines: string[] = []

    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk))

      return true
    })

    return { lines }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a debug message to stdout at DEBUG level', () => {
    const { lines } = captureStdout()
    const log = new Logger({ serviceName: 'X', minLevel: 'DEBUG' })

    log.debug('DBG_MARKER')

    expect(lines.join('')).toEqual(expect.stringContaining('DBG_MARKER'))
  })

  it('suppresses lower-severity messages below minLevel and lets higher-severity through', () => {
    // The gate prints when `level.rank >= minLevel`. At minLevel INFO(1), debug (rank 0)
    // is dropped while info (rank 1) and warn (rank 2) are written.
    const { lines } = captureStdout()
    const log = new Logger({ serviceName: 'X', minLevel: 'INFO' })

    log.debug('DEBUG_MARKER')
    log.info('INFO_MARKER')
    log.warn('WARN_MARKER')

    const output = lines.join('')

    expect(output).not.toContain('DEBUG_MARKER')
    expect(output).toEqual(expect.stringContaining('INFO_MARKER'))
    expect(output).toEqual(expect.stringContaining('WARN_MARKER'))
  })

  it('truncates output to maxExtraDataLength, cutting off deep extra-data', () => {
    const { lines } = captureStdout()
    const log = new Logger({ serviceName: 'X', minLevel: 'DEBUG', maxExtraDataLength: 20 })

    log.debug('hello', { secret: 'NEEDLE_SHOULD_BE_CUT' })

    const output = lines.join('')

    expect(output).toEqual(expect.stringContaining('hello'))
    expect(output).not.toContain('NEEDLE_SHOULD_BE_CUT')
  })
})
