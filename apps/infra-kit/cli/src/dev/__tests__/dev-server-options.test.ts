import { describe, expect, it } from 'vitest'

import { toDevServerOptions } from 'src/entry/dev-server'
import type { DevCliOptions } from 'src/entry/dev-server'

/**
 * Flag/option parsing for the dev-server CLI entry. `toDevServerOptions` maps the
 * raw Commander flag object (comma-joined strings) to the typed `DevServerOptions`
 * the orchestrator consumes. Pure function — no fixtures.
 */
describe('toDevServerOptions — CLI flag parsing', () => {
  it('splits --app into an include list', () => {
    const opts = toDevServerOptions({ app: 'client,backoffice' } satisfies DevCliOptions)

    expect(opts.include).toEqual(['client', 'backoffice'])
  })

  it('trims whitespace and drops empty segments in comma lists', () => {
    const opts = toDevServerOptions({ app: ' client , , backoffice ,' } satisfies DevCliOptions)

    expect(opts.include).toEqual(['client', 'backoffice'])
  })

  it('maps a missing --app to null (means "all apps")', () => {
    const opts = toDevServerOptions({} satisfies DevCliOptions)

    expect(opts.include).toBeNull()
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

  it('parses a combined flag set (--app --watch) in one pass', () => {
    const opts = toDevServerOptions({ app: 'a,b', watch: true } satisfies DevCliOptions)

    expect(opts).toEqual({ watch: true, include: ['a', 'b'] })
  })
})
