import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDevLogger } from '../dev-logger.js'

type Spied = 'debug' | 'info' | 'warn' | 'error'

let lines: Record<Spied, Record<string, unknown>[]>

beforeEach(() => {
  lines = { debug: [], info: [], warn: [], error: [] }
  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((line: string) => {
      lines[method].push(JSON.parse(line) as Record<string, unknown>)
    })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createDevLogger', () => {
  it('prints one JSON line per call with level, message, service and timestamp', () => {
    createDevLogger('LocalServer').info('hello')

    expect(lines.info).toEqual([
      { level: 'INFO', message: 'hello', service: 'LocalServer', timestamp: expect.any(String) },
    ])
  })

  it('sends each level to the matching console method, critical to error', () => {
    const log = createDevLogger('svc')

    log.debug('d')
    log.warn('w')
    log.error('e')
    log.critical('c')

    expect(
      lines.debug.map((l) => {
        return l.level
      }),
    ).toEqual(['DEBUG'])
    expect(
      lines.warn.map((l) => {
        return l.level
      }),
    ).toEqual(['WARN'])
    expect(
      lines.error.map((l) => {
        return l.level
      }),
    ).toEqual(['ERROR', 'CRITICAL'])
  })

  it('merges object extras, serializes an Error under `error`, and collects primitives under `extra`', () => {
    createDevLogger('svc').error('failed', { orderId: 7 }, new TypeError('boom'), 'raw', 3)

    expect(lines.error[0]).toMatchObject({
      message: 'failed',
      orderId: 7,
      error: { name: 'TypeError', message: 'boom', stack: expect.stringContaining('boom') },
      extra: ['raw', 3],
    })
  })

  it('accepts an attributes object as the message', () => {
    createDevLogger('svc').info({ message: 'm', requestId: 'r1' })

    expect(lines.info[0]).toMatchObject({ message: 'm', requestId: 'r1' })
  })

  it('keeps appended keys until removed, and a child inherits them without leaking its own back', () => {
    const parent = createDevLogger('parent')

    parent.appendKeys({ tenant: 'a', region: 'eu' })
    const child = parent.createChild({ serviceName: 'child' })

    child.appendKeys({ childOnly: true })
    parent.removeKeys(['region'])
    parent.info('p')
    child.info('c')

    expect(lines.info[0]).toMatchObject({ service: 'parent', tenant: 'a' })
    expect(lines.info[0]).not.toHaveProperty('region')
    expect(lines.info[0]).not.toHaveProperty('childOnly')
    expect(lines.info[1]).toMatchObject({ service: 'child', tenant: 'a', region: 'eu', childOnly: true })
  })

  it('keeps the parent service name when the child is created without one', () => {
    createDevLogger('parent').createChild().info('c')

    expect(lines.info[0]).toMatchObject({ service: 'parent' })
  })
})
