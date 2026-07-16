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

    expect(opts).toEqual({
      watch: true,
      include: ['a', 'b'],
      preset: undefined,
      cmux: false,
      self: false,
      verbose: false,
      routes: false,
      uiHealth: true,
    })
  })

  it('passes the preset positional through', () => {
    expect(toDevServerOptions({ preset: 'client-remote' } satisfies DevCliOptions).preset).toBe('client-remote')
  })

  it('leaves preset undefined when none is given (run everything)', () => {
    expect(toDevServerOptions({} satisfies DevCliOptions).preset).toBeUndefined()
  })

  it('defaults cmux to false when --cmux is absent', () => {
    expect(toDevServerOptions({} satisfies DevCliOptions).cmux).toBe(false)
  })

  it('passes --cmux through as true', () => {
    expect(toDevServerOptions({ cmux: true } satisfies DevCliOptions).cmux).toBe(true)
  })

  it('defaults self to false when --self is absent', () => {
    expect(toDevServerOptions({} satisfies DevCliOptions).self).toBe(false)
  })

  it('passes --self through as true', () => {
    expect(toDevServerOptions({ self: true } satisfies DevCliOptions).self).toBe(true)
  })

  it('leaves presetDef undefined when --target is absent, so preset/`*` resolution is untouched', () => {
    expect(toDevServerOptions({} satisfies DevCliOptions).presetDef).toBeUndefined()
  })

  it('turns --target into an in-memory preset keyed by the exact target keys', () => {
    const options = toDevServerOptions({ target: 'client/api, client/ui' } satisfies DevCliOptions)

    expect(options.presetDef).toEqual({ apps: { 'client/api': {}, 'client/ui': {} } })
  })

  it('rejects a bare app name, which names a folder rather than a package', () => {
    expect(() => {
      return toDevServerOptions({ target: 'client' } satisfies DevCliOptions)
    }).toThrow(/invalid --target "client"/)
  })

  it('rejects an unknown part', () => {
    expect(() => {
      return toDevServerOptions({ target: 'client/worker' } satisfies DevCliOptions)
    }).toThrow(/invalid --target "client\/worker"/)
  })
})
