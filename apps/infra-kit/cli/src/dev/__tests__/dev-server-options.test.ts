import { describe, expect, it } from 'vitest'

import { toDevServerOptions } from 'src/entry/dev-server'
import type { DevCliOptions } from 'src/entry/dev-server'

/**
 * Flag/option parsing for the dev-server CLI entry. `toDevServerOptions` maps the
 * raw Commander flag object (comma-joined strings, string port) to the typed
 * `DevServerOptions` the orchestrator consumes. Pure function — no fixtures.
 */
describe('toDevServerOptions — CLI flag parsing', () => {
  it('splits --app into an include list', () => {
    const opts = toDevServerOptions({ app: 'client,backoffice' } satisfies DevCliOptions)

    expect(opts.include).toEqual(['client', 'backoffice'])
  })

  it('splits --exclude into an exclude list', () => {
    const opts = toDevServerOptions({ exclude: 'search-engine' } satisfies DevCliOptions)

    expect(opts.exclude).toEqual(['search-engine'])
  })

  it('trims whitespace and drops empty segments in comma lists', () => {
    const opts = toDevServerOptions({ app: ' client , , backoffice ,' } satisfies DevCliOptions)

    expect(opts.include).toEqual(['client', 'backoffice'])
  })

  it('maps a missing --app/--exclude to null (means "all apps")', () => {
    const opts = toDevServerOptions({} satisfies DevCliOptions)

    expect(opts.include).toBeNull()
    expect(opts.exclude).toBeNull()
  })

  it('maps an all-empty comma list to null rather than an empty array', () => {
    const opts = toDevServerOptions({ app: ' , , ' } satisfies DevCliOptions)

    expect(opts.include).toBeNull()
  })

  it('defaults watch to false when the flag is absent', () => {
    expect(toDevServerOptions({} satisfies DevCliOptions).watch).toBe(false)
  })

  it('passes --watch through as true', () => {
    expect(toDevServerOptions({ watch: true } satisfies DevCliOptions).watch).toBe(true)
  })

  it('parses --port into a number', () => {
    expect(toDevServerOptions({ port: '4123' } satisfies DevCliOptions).port).toBe(4123)
  })

  it('omits port entirely when --port is unset', () => {
    expect('port' in toDevServerOptions({} satisfies DevCliOptions)).toBe(false)
  })

  it('omits port when --port is not a parseable number', () => {
    expect('port' in toDevServerOptions({ port: 'abc' } satisfies DevCliOptions)).toBe(false)
  })

  it('parses a combined flag set (--app --exclude --watch --port) in one pass', () => {
    const opts = toDevServerOptions({
      app: 'a,b',
      exclude: 'c',
      watch: true,
      port: '3999',
    } satisfies DevCliOptions)

    expect(opts).toEqual({ watch: true, include: ['a', 'b'], exclude: ['c'], port: 3999 })
  })
})
