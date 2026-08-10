import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PORT,
  DEFAULT_PREFIX_URL,
  findPortConflicts,
  parsePortString,
  resolvePort,
  resolvePreferredPort,
  resolvePrefixUrl,
} from 'src/dev/ports'

/**
 * Pure port / prefix resolution. Every function is side-effect free, so these
 * specs pass `env` and `devConfig` in as plain objects — no fixtures, no cwd,
 * no process.env mutation.
 */
describe('resolvePort — precedence order', () => {
  it('falls back to the 3010 default when nothing is set', () => {
    expect(resolvePort('client', {}, {})).toBe(DEFAULT_PORT)
  })

  it('uses dev.<app>.port from config over the default', () => {
    expect(resolvePort('client', {}, { client: { port: 3200 } })).toBe(3200)
  })

  it('lets PORT beat the config port', () => {
    expect(resolvePort('client', { PORT: '3300' }, { client: { port: 3200 } })).toBe(3300)
  })

  it('lets {APP}_PORT beat PORT and config', () => {
    expect(resolvePort('client', { PORT: '3300', CLIENT_PORT: '3400' }, { client: { port: 3200 } })).toBe(3400)
  })

  it('maps a hyphenated app name to UPPER_SNAKE_CASE for the {APP}_PORT key', () => {
    expect(resolvePort('search-engine', { SEARCH_ENGINE_PORT: '3500' }, {})).toBe(3500)
  })

  it('honors {APP}_PORT = 0 and does NOT fall through to a lower tier', () => {
    // 0 is a valid "pick a free port" request; only null/undefined means "unset".
    expect(resolvePort('client', { CLIENT_PORT: '0' }, { client: { port: 3200 } })).toBe(0)
  })

  it('strips surrounding quotes on a {APP}_PORT env value', () => {
    // Secrets managers can export values wrapped in quotes.
    expect(resolvePort('client', { CLIENT_PORT: '"3400"' }, {})).toBe(3400)
  })
})

describe('resolvePreferredPort — explicit-only (no DEFAULT_PORT fallback)', () => {
  it('returns undefined when nothing is explicitly configured (no DEFAULT_PORT fallback)', () => {
    expect(resolvePreferredPort('client', {}, {})).toBeUndefined()
  })

  it('returns dev.<app>.port from config when set', () => {
    expect(resolvePreferredPort('client', {}, { client: { port: 3200 } })).toBe(3200)
  })

  it('lets PORT and {APP}_PORT take precedence, in that order', () => {
    expect(resolvePreferredPort('client', { PORT: '3300' }, { client: { port: 3200 } })).toBe(3300)
    expect(resolvePreferredPort('client', { PORT: '3300', CLIENT_PORT: '3400' }, {})).toBe(3400)
  })

  it('preserves an explicit {APP}_PORT = 0 (ephemeral request), not undefined', () => {
    expect(resolvePreferredPort('client', { CLIENT_PORT: '0' }, {})).toBe(0)
  })
})

/**
 * The bare `PORT` tier is the only one that is not app-scoped, so in a multi-app run it hands every
 * app the same value and the caller's conflict gate then refuses to start over duplicates the
 * environment manufactured. `allowBarePort` is how the caller declines that tier once it knows more
 * than one app is launching; nothing else about the precedence changes.
 */
describe('resolvePreferredPort — allowBarePort gates ONLY the bare PORT tier', () => {
  it('drops a bare PORT when denied, and keeps it when allowed or omitted', () => {
    expect(resolvePreferredPort('client', { PORT: '3300' }, {}, false)).toBeUndefined()
    expect(resolvePreferredPort('client', { PORT: '3300' }, {}, true)).toBe(3300)
    expect(resolvePreferredPort('client', { PORT: '3300' }, {})).toBe(3300)
  })

  it('leaves the per-app {APP}_PORT tier untouched when the bare tier is denied', () => {
    expect(resolvePreferredPort('client', { PORT: '3300', CLIENT_PORT: '3400' }, {}, false)).toBe(3400)
  })

  it('reaches the config tier when the bare tier is denied, rather than skipping to undefined', () => {
    expect(resolvePreferredPort('client', { PORT: '3300' }, { client: { port: 3200 } }, false)).toBe(3200)
  })
})

describe('resolvePrefixUrl — config over default', () => {
  it('defaults to /api/v1 when nothing is configured', () => {
    expect(resolvePrefixUrl('client', {})).toBe(DEFAULT_PREFIX_URL)
  })

  it('honors dev.<app>.prefixUrl over the default', () => {
    expect(resolvePrefixUrl('client', { client: { prefixUrl: '/custom/v2' } })).toBe('/custom/v2')
  })
})

describe('parsePortString — raw port coercion', () => {
  it('strips a single pair of surrounding quotes', () => {
    expect(parsePortString('"3400"')).toBe(3400)
    expect(parsePortString("'3400'")).toBe(3400)
  })

  it('returns undefined for non-numeric input', () => {
    expect(parsePortString('abc')).toBeUndefined()
  })

  it('returns undefined for undefined and blank input', () => {
    expect(parsePortString(undefined)).toBeUndefined()
    expect(parsePortString('')).toBeUndefined()
  })
})

describe('findPortConflicts — duplicate detection', () => {
  it('reports the duplicate port and every colliding app when two apps share a port', () => {
    const result = findPortConflicts([
      { name: 'client', port: 3010 },
      { name: 'backoffice', port: 3010 },
    ])

    expect(result.duplicatePorts).toEqual([3010])
    expect(result.conflictingApps).toEqual([
      { name: 'client', port: 3010 },
      { name: 'backoffice', port: 3010 },
    ])
  })

  it('reports no conflict when every app resolves to a distinct port', () => {
    const result = findPortConflicts([
      { name: 'client', port: 3010 },
      { name: 'backoffice', port: 3011 },
    ])

    expect(result.duplicatePorts).toEqual([])
    expect(result.conflictingApps).toEqual([])
  })
})
