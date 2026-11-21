import { describe, expect, it } from 'vitest'

import { TURBO_SERVICE, createLogLineFormatter, formatLogRecord, sanitizeLine } from 'src/dev/log-format'
import { stripAnsi as renderStripAnsi } from 'src/dev/render'
import { stripAnsi as uiDevStripAnsi } from 'src/dev/ui-dev'

const T = '2026-11-12T10:00:00.000Z'

/** The shape every physical line of a dev log file must have. */
const LINE_SHAPE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (?:DEBUG|INFO |WARN |ERROR) \S+ .*$/

const lines = (out: string): string[] => {
  expect(out.endsWith('\n')).toBe(true)

  return out.slice(0, -1).split('\n')
}

describe('formatLogRecord — plain lines', () => {
  it('prefixes a line with time, padded level and service', () => {
    expect(formatLogRecord({ time: T, service: 'client/ui', text: 'ready in 90 ms', level: 'info' })).toBe(
      `${T} INFO  client/ui ready in 90 ms\n`,
    )
    expect(formatLogRecord({ time: T, service: 'runner', text: 'x\n', level: 'warn' })).toBe(`${T} WARN  runner x\n`)
  })

  it('writes one prefixed line per physical line, all with the same stamp (a stack stays readable)', () => {
    const stack = 'Error: boom\n    at a (/x.js:1:1)\n    at b (/x.js:2:2)'
    const out = lines(formatLogRecord({ time: T, service: 'client/api', text: stack, level: 'error' }))

    expect(out).toEqual([
      `${T} ERROR client/api Error: boom`,
      `${T} ERROR client/api     at a (/x.js:1:1)`,
      `${T} ERROR client/api     at b (/x.js:2:2)`,
    ])
  })

  it('strips ANSI escapes and C0 controls, keeping TAB', () => {
    const text = '\u001B[32mgreen\u001B[0m \u001B]8;;file:///x\u001B\\link\u001B]8;;\u001B\\\tbell\u0007'

    expect(formatLogRecord({ time: T, service: 's', text, level: 'info' })).toBe(`${T} INFO  s green link\tbell\n`)
  })

  it('collapses a bare-CR progress line to what the terminal finally showed, before stripping', () => {
    // Stripped first, the CRs would vanish and glue every redraw into `10%50%done`.
    expect(sanitizeLine('progress 10%\rprogress 50%\rdone')).toBe('done')
    expect(sanitizeLine('a\r\nb')).toBe('a\nb')
    expect(sanitizeLine('\u001B[2K\rbuilding\r')).toBe('building')
    expect(formatLogRecord({ time: T, service: 's', text: '10%\r100%\nnext', level: 'info' })).toBe(
      `${T} INFO  s 100%\n${T} INFO  s next\n`,
    )
  })

  it('is INFO when nothing declares a level', () => {
    expect(formatLogRecord({ time: T, service: 's', text: 'error TS2322 in a non-turbo stream' })).toBe(
      `${T} INFO  s error TS2322 in a non-turbo stream\n`,
    )
  })
})

describe('formatLogRecord — turbo redraws', () => {
  it('keeps the task prefix in front of the last bare-CR redraw on the turbo stream', () => {
    expect(formatLogRecord({ time: T, service: TURBO_SERVICE, text: 'shop-ui:dev: 10%\r50%\r100%\n' })).toBe(
      `${T} INFO  turbo shop-ui:dev: 100%\n`,
    )
    expect(
      formatLogRecord({
        time: T,
        service: TURBO_SERVICE,
        text: '\u001B[35mshop-ui:dev:\u001B[0m 1/3\r\u001B[31merror: x',
      }),
    ).toBe(`${T} ERROR turbo shop-ui:dev: error: x\n`)
  })

  it('leaves a CRLF line end, an unprefixed redraw and a non-turbo stream to the generic collapse', () => {
    expect(formatLogRecord({ time: T, service: TURBO_SERVICE, text: 'shop-ui:dev: ready\r\nnext' })).toBe(
      `${T} INFO  turbo shop-ui:dev: ready\n${T} INFO  turbo next\n`,
    )
    expect(formatLogRecord({ time: T, service: TURBO_SERVICE, text: 'chrome 1\rchrome 2' })).toBe(
      `${T} INFO  turbo chrome 2\n`,
    )
    expect(formatLogRecord({ time: T, service: 'watch', text: 'shop-ui:dev: 10%\r100%' })).toBe(
      `${T} INFO  watch 100%\n`,
    )
  })
})

describe('formatLogRecord — level precedence', () => {
  it('classifies an undeclared turbo `<pkg>:dev:` line with turboLineLevel, and only on the turbo stream', () => {
    const failing = 'shop-ui:dev: ✘ [ERROR] Could not resolve "x"'

    expect(formatLogRecord({ time: T, service: TURBO_SERVICE, text: failing })).toBe(`${T} ERROR turbo ${failing}\n`)
    expect(formatLogRecord({ time: T, service: TURBO_SERVICE, text: 'shop-ui:dev: ready' })).toContain(' INFO  ')
    // Turbo chrome carries no task prefix: not a format the classifier knows, so it is not classified.
    expect(formatLogRecord({ time: T, service: TURBO_SERVICE, text: 'Error: chrome' })).toContain(' INFO  ')
    expect(formatLogRecord({ time: T, service: 'watch', text: failing })).toContain(' INFO  ')
  })

  it('lets a declared level win over turboLineLevel', () => {
    expect(formatLogRecord({ time: T, service: TURBO_SERVICE, text: 'shop-ui:dev: error x', level: 'debug' })).toBe(
      `${T} DEBUG turbo shop-ui:dev: error x\n`,
    )
  })

  it('lets a JSON record’s own level win over the declared one; CRITICAL maps to ERROR', () => {
    const record = (level: string): string => {
      return JSON.stringify({ level, message: 'm', timestamp: T })
    }

    expect(formatLogRecord({ time: T, service: 'a/api', text: record('WARN'), level: 'info' })).toBe(
      `${T} WARN  a/api m\n`,
    )
    expect(formatLogRecord({ time: T, service: 'a/api', text: record('CRITICAL'), level: 'info' })).toBe(
      `${T} ERROR a/api m\n`,
    )
    expect(formatLogRecord({ time: T, service: 'a/api', text: record('verbose'), level: 'warn' })).toBe(
      `${T} WARN  a/api m\n`,
    )
  })
})

describe('formatLogRecord — backend JSON', () => {
  it('unfolds time, level and message from the record, and writes the remaining keys as extras', () => {
    const text = JSON.stringify({
      level: 'INFO',
      message: 'order placed',
      service: 'orders',
      timestamp: '2026-11-12T09:59:59.123Z',
      orderId: 7,
    })

    expect(formatLogRecord({ time: T, service: 'shop/api', text, level: 'info' })).toBe(
      `2026-11-12T09:59:59.123Z INFO  shop/api order placed {"service":"orders","orderId":7}\n`,
    )
  })

  it('drops `service` from the extras when it names the file’s own service, and reads `msg`/`time`', () => {
    const text = JSON.stringify({ msg: 'hi', time: 1_762_941_600_000, service: 'shop/api' })

    expect(formatLogRecord({ time: T, service: 'shop/api', text })).toBe(`2025-11-12T10:00:00.000Z INFO  shop/api hi\n`)
  })

  it('writes `error.stack` as continuation lines and keeps the rest of the error in the extras', () => {
    const text = JSON.stringify({
      level: 'ERROR',
      message: 'handler failed',
      timestamp: T,
      error: { name: 'TypeError', message: 'x is not a function', stack: 'TypeError: x\n    at h (/h.js:1:1)' },
    })

    expect(lines(formatLogRecord({ time: T, service: 'shop/api', text }))).toEqual([
      `${T} ERROR shop/api handler failed {"error":{"name":"TypeError","message":"x is not a function"}}`,
      `${T} ERROR shop/api TypeError: x`,
      `${T} ERROR shop/api     at h (/h.js:1:1)`,
    ])
  })

  it('falls back to the sink stamp for an unparseable record time, and strips escapes inside the message', () => {
    const text = JSON.stringify({ message: '\u001B[31mred\u001B[0m', timestamp: 'yesterday' })

    expect(formatLogRecord({ time: T, service: 's', text })).toBe(`${T} INFO  s red\n`)
  })

  it('leaves JSON without a string message, and broken JSON, as plain lines', () => {
    expect(formatLogRecord({ time: T, service: 's', text: '{"a":1}' })).toBe(`${T} INFO  s {"a":1}\n`)
    expect(formatLogRecord({ time: T, service: 's', text: '{ not json' })).toBe(`${T} INFO  s { not json\n`)
  })
})

describe('createLogLineFormatter', () => {
  it('stamps from the injected clock', () => {
    const ticks = [new Date('2026-01-01T00:00:00.001Z'), new Date('2026-01-01T00:00:00.002Z')]

    const format = createLogLineFormatter(() => {
      return ticks.shift() ?? new Date(0)
    })

    expect(format('s', 'a', 'info')).toBe('2026-01-01T00:00:00.001Z INFO  s a\n')
    expect(format('s', 'b', undefined)).toBe('2026-01-01T00:00:00.002Z INFO  s b\n')
  })

  it('formats the `[capped]` notice the sink hands it as one WARN line of the shared shape', () => {
    const format = createLogLineFormatter(() => {
      return new Date(T)
    })

    const out = format(
      'runner',
      '[capped] runner.log hit 64 bytes; further lines dropped (likely a logging loop)',
      'warn',
    )

    expect(out).toBe(
      `${T} WARN  runner [capped] runner.log hit 64 bytes; further lines dropped (likely a logging loop)\n`,
    )
    expect(
      lines(out).every((line) => {
        return LINE_SHAPE.test(line)
      }),
    ).toBe(true)
  })
})

describe('the two stripAnsi functions', () => {
  // They differ on purpose: render's keeps terminal-facing text intact apart from SGR and OSC-8, while
  // the ui-dev superset (shared with the log files) removes every CSI, OSC and C0 control but TAB.
  const sample = 'a\u001B[1mb\u001B[0m\u001B]8;;file:///x\u001B\\c\u001B]8;;\u001B\\\u001B[2Kd\re\u0007\tf'

  it('render: strips SGR and OSC-8 only', () => {
    expect(renderStripAnsi(sample)).toBe('abc\u001B[2Kd\re\u0007\tf')
  })

  it('ui-dev (re-exported from log-format): strips every CSI, OSC and C0 control except TAB', () => {
    expect(uiDevStripAnsi(sample)).toBe('abcde\tf')
  })
})
